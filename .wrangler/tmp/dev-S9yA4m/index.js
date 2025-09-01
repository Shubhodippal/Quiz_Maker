var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers || {} }
  });
}
__name(json, "json");
function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
__name(generateCode, "generateCode");
var RANK_POINTS = [5, 4, 3, 2, 1];
var MIN_POINTS_FOR_CORRECT = 1;
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/room" && request.method === "POST") {
      const raw = await request.json();
      const code = generateCode();
      await env.DB.prepare("INSERT INTO rooms (code, created_at) VALUES (?, ?)").bind(code, Date.now()).run();
      let pos = 0;
      for (const q of raw) {
        const qid = `${code}:${q.id}`;
        const correctId = q.correct_option_id ? `${qid}:${q.correct_option_id}` : null;
        await env.DB.prepare(
          "INSERT INTO questions (id, room_code, text, correct_option_id, position) VALUES (?, ?, ?, ?, ?)"
        ).bind(qid, code, q.text, correctId, pos++).run();
        for (const o of q.options || []) {
          const oid = `${qid}:${o.id}`;
          await env.DB.prepare("INSERT INTO options (id, question_id, text) VALUES (?, ?, ?)").bind(oid, qid, o.text).run();
        }
      }
      const id = env.ROOM.idFromName(code);
      await env.ROOM.get(id).fetch("https://do/bootstrap?code=" + code);
      return json({ code });
    }
    const reg = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/register$/);
    if (reg && request.method === "POST") {
      const code = reg[1];
      const body = await request.json();
      if (!body.name || body.name.trim().length === 0) {
        return json({ error: "Name is required" }, { status: 400 });
      }
      if (!body.email || body.email.trim().length === 0) {
        return json({ error: "Email is required" }, { status: 400 });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.email.trim())) {
        return json({ error: "Please provide a valid email address" }, { status: 400 });
      }
      if (!body.phone || body.phone.trim().length === 0) {
        return json({ error: "Phone number is required" }, { status: 400 });
      }
      const phoneDigits = body.phone.trim().replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        return json({ error: "Please provide a valid phone number with at least 10 digits" }, { status: 400 });
      }
      const pid = crypto.randomUUID();
      const name = body.name.trim();
      const email = body.email.trim().toLowerCase();
      const phone = body.phone.trim();
      await env.DB.prepare(
        "INSERT INTO players (id, room_code, name, email, phone, score) VALUES (?, ?, ?, ?, ?, 0)"
      ).bind(pid, code, name, email, phone).run();
      return json({ id: pid, name, email, phone });
    }
    const plist = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/participants$/);
    if (plist && request.method === "GET") {
      const code = plist[1];
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "250", 10), 250);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM players WHERE room_code = ?"
      ).bind(code).first();
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, phone, score FROM players WHERE room_code = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?"
      ).bind(code, limit, offset).all();
      return json({ total: totalRow?.c || 0, items: results || [] });
    }
    const win = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/winners$/);
    if (win && request.method === "GET") {
      const code = win[1];
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, phone, score FROM players WHERE room_code = ? ORDER BY score DESC, id LIMIT 5"
      ).bind(code).all();
      return json(results || []);
    }
    const questions = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/questions$/);
    if (questions && request.method === "GET") {
      const code = questions[1];
      try {
        const { results: questionResults } = await env.DB.prepare(
          "SELECT q.id, q.text, q.correct_option_id, q.position FROM questions q WHERE q.room_code = ? ORDER BY position ASC"
        ).bind(code).all();
        const questionsWithOptions = await Promise.all(
          (questionResults || []).map(async (q) => {
            const { results: optionResults } = await env.DB.prepare(
              "SELECT id, text FROM options WHERE question_id = ? ORDER BY id"
            ).bind(q.id).all();
            return {
              id: q.id,
              text: q.text,
              correct_option_id: q.correct_option_id,
              position: q.position,
              options: optionResults || []
            };
          })
        );
        return json(questionsWithOptions);
      } catch (error) {
        console.error("Error fetching questions:", error);
        return json({ error: "Failed to fetch questions" }, { status: 500 });
      }
    }
    const next = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/next$/);
    if (next && request.method === "POST") {
      const code = next[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch("https://do/next", { method: "POST" });
    }
    const stream = url.pathname.match(/^\/stream\/([A-Z0-9]{5})$/);
    if (stream && request.method === "GET") {
      const code = stream[1];
      const id = env.ROOM.idFromName(code);
      const sseRequest = new Request("https://do/stream", {
        headers: {
          ...request.headers,
          "Accept": "text/event-stream"
        }
      });
      return env.ROOM.get(id).fetch(sseRequest);
    }
    const answerSubmit = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/answer$/);
    if (answerSubmit && request.method === "POST") {
      const code = answerSubmit[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch("https://do/answer", {
        method: "POST",
        body: await request.text(),
        headers: { "Content-Type": "application/json" }
      });
    }
    const adminStream = url.pathname.match(/^\/admin\/stream\/([A-Z0-9]{5})$/);
    if (adminStream && request.method === "GET") {
      const code = adminStream[1];
      const id = env.ROOM.idFromName(code);
      const adminRequest = new Request("https://do/admin/stream", {
        headers: {
          ...request.headers,
          "Accept": "text/event-stream"
        }
      });
      return env.ROOM.get(id).fetch(adminRequest);
    }
    const ws = url.pathname.match(/^\/ws\/([A-Z0-9]{5})$/);
    if (ws && request.headers.get("Upgrade") === "websocket") {
      const code = ws[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
var Room = class {
  static {
    __name(this, "Room");
  }
  state;
  env;
  code = "";
  clients = /* @__PURE__ */ new Set();
  sseConnections = /* @__PURE__ */ new Set();
  present = /* @__PURE__ */ new Map();
  // Connection management for high load
  maxConnections = 1e3;
  // Increased limit for scalability
  connectionCounter = 0;
  lastCleanup = 0;
  // Rate limiting for answer submissions
  answerAttempts = /* @__PURE__ */ new Map();
  // playerId -> attempts count
  lastAnswerReset = 0;
  currentIndex = -1;
  currentQuestionId = null;
  // prefixed id
  currentStartMs = 0;
  collecting = false;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      const data = await this.state.storage.get("room");
      if (data) {
        this.code = data.code;
        this.currentIndex = data.currentIndex ?? -1;
        this.currentQuestionId = data.currentQuestionId ?? null;
        this.currentStartMs = data.currentStartMs ?? 0;
        this.collecting = !!data.collecting;
      }
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/bootstrap") {
      this.code = url.searchParams.get("code") || this.code;
      await this.persist();
      return new Response("ok");
    }
    if (url.pathname === "/next" && request.method === "POST") {
      try {
        const q = await this.loadNextQuestion();
        if (!q) {
          return json({ error: "No more questions" });
        }
        this.currentQuestionId = q.id;
        this.currentStartMs = Date.now();
        this.collecting = true;
        this.answerAttempts.clear();
        this.lastAnswerReset = Date.now();
        await this.state.storage.setAlarm(new Date(this.currentStartMs + 25e3));
        const broadcastSuccess = this.broadcast({
          type: "question",
          question: q,
          deadline: this.currentStartMs + 25e3,
          totalConnections: this.clients.size + this.sseConnections.size
        });
        await this.persist();
        return json({
          ok: true,
          questionId: q.id,
          connectedClients: this.clients.size + this.sseConnections.size,
          deadline: this.currentStartMs + 25e3
        });
      } catch (error) {
        console.error("Error in next question:", error);
        return json({ error: "Failed to load next question" }, { status: 500 });
      }
    }
    if (url.pathname === "/stream" && request.headers.get("Accept")?.includes("text/event-stream")) {
      return this.handleSSEConnection(request, false);
    }
    if (url.pathname === "/admin/stream" && request.headers.get("Accept")?.includes("text/event-stream")) {
      return this.handleSSEConnection(request, true);
    }
    if (url.pathname === "/answer" && request.method === "POST") {
      return this.handleAnswerSubmission(request);
    }
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }
  handleSession(ws) {
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, "Server overloaded");
      return;
    }
    const client = { ws };
    ws.accept();
    this.clients.add(client);
    this.connectionCounter++;
    if (Date.now() - this.lastCleanup > 6e4) {
      this.cleanupStaleConnections();
      this.lastCleanup = Date.now();
    }
    ws.addEventListener("message", async (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "register") {
          client.playerId = data.playerId;
          client.isAdmin = !!data.isAdmin;
          if (data.player && data.player.id && !client.isAdmin) {
            this.present.set(data.player.id, {
              name: data.player.name || "Player",
              email: data.player.email || ""
            });
            this.broadcast({ type: "presence", count: this.present.size });
          }
          ws.send(JSON.stringify({ type: "registered", ok: true }));
        } else if (data.type === "answer") {
          if (!this.collecting || !this.currentQuestionId) {
            ws.send(JSON.stringify({ type: "error", message: "Answer window closed." }));
            return;
          }
          if (!data.playerId || !data.optionId) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid answer data." }));
            return;
          }
          const attempts = this.answerAttempts.get(data.playerId) || 0;
          if (attempts >= 3) {
            ws.send(JSON.stringify({ type: "error", message: "Too many answer attempts." }));
            return;
          }
          this.answerAttempts.set(data.playerId, attempts + 1);
          const already = await this.hasAnswered(this.currentQuestionId, data.playerId);
          if (already) {
            ws.send(JSON.stringify({ type: "error", message: "You have already answered this question." }));
            return;
          }
          try {
            await this.storeAnswer(this.currentQuestionId, data.playerId, data.optionId);
            ws.send(JSON.stringify({ type: "accepted", at: Date.now() }));
          } catch (error) {
            console.error("Answer storage failed:", error);
            ws.send(JSON.stringify({ type: "error", message: "Failed to submit answer. Please try again." }));
          }
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (e) {
        console.error("WebSocket message error:", e);
        try {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        } catch (sendError) {
          console.error("Failed to send error message:", sendError);
        }
      }
    });
    ws.addEventListener("close", () => {
      if (client.playerId && this.present.has(client.playerId)) {
        this.present.delete(client.playerId);
        this.broadcast({ type: "presence", count: this.present.size });
      }
      this.clients.delete(client);
    });
    ws.addEventListener("error", (error) => {
      console.error("WebSocket error for client:", error);
      this.clients.delete(client);
    });
  }
  // SSE Connection Handler
  handleSSEConnection(request, isAdmin) {
    if (this.sseConnections.size >= this.maxConnections) {
      return new Response("Server overloaded", { status: 503 });
    }
    const url = new URL(request.url);
    const lastEventId = request.headers.get("Last-Event-ID") || url.searchParams.get("lastEventId") || "0";
    const playerId = url.searchParams.get("playerId");
    let connectionClosed = false;
    const stream = new ReadableStream({
      start: /* @__PURE__ */ __name(async (controller) => {
        const connection = {
          controller,
          playerId: playerId || void 0,
          isAdmin,
          lastEventId,
          connectedAt: Date.now()
        };
        this.sseConnections.add(connection);
        this.sendSSEMessage(controller, {
          type: "connected",
          timestamp: Date.now(),
          connectedClients: this.clients.size + this.sseConnections.size
        }, "connected");
        if (playerId && !isAdmin) {
          try {
            const playerRow = await this.env.DB.prepare(
              "SELECT name, email FROM players WHERE id = ? AND room_code = ?"
            ).bind(playerId, this.code).first();
            if (playerRow) {
              this.present.set(playerId, {
                name: playerRow.name || "Player",
                email: playerRow.email || ""
              });
              this.broadcast({ type: "presence", count: this.present.size });
            }
          } catch (error) {
            console.error("Error tracking presence for SSE player:", error);
          }
        }
        if (this.collecting && this.currentQuestionId) {
          this.getCurrentQuestion().then((question) => {
            if (question) {
              this.sendSSEMessage(controller, {
                type: "question",
                question,
                deadline: this.currentStartMs + 25e3
              }, "question");
            }
          }).catch((error) => {
            console.error("Error sending current question to SSE client:", error);
          });
        }
      }, "start"),
      cancel: /* @__PURE__ */ __name(() => {
        connectionClosed = true;
        for (const conn of this.sseConnections) {
          if (conn.controller === arguments[0]) {
            this.sseConnections.delete(conn);
            if (conn.playerId && this.present.has(conn.playerId)) {
              this.present.delete(conn.playerId);
              this.broadcast({ type: "presence", count: this.present.size });
            }
            break;
          }
        }
      }, "cancel")
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control"
      }
    });
  }
  // Answer Submission Handler
  async handleAnswerSubmission(request) {
    try {
      const body = await request.json();
      if (!this.collecting || !this.currentQuestionId) {
        return json({ type: "error", message: "Answer window closed." }, { status: 400 });
      }
      if (!body.playerId || !body.optionId) {
        return json({ type: "error", message: "Invalid answer data." }, { status: 400 });
      }
      const attempts = this.answerAttempts.get(body.playerId) || 0;
      if (attempts >= 3) {
        return json({ type: "error", message: "Too many answer attempts." }, { status: 429 });
      }
      this.answerAttempts.set(body.playerId, attempts + 1);
      const already = await this.hasAnswered(this.currentQuestionId, body.playerId);
      if (already) {
        return json({ type: "error", message: "You have already answered this question." }, { status: 409 });
      }
      try {
        await this.storeAnswer(this.currentQuestionId, body.playerId, body.optionId);
        return json({ type: "accepted", at: Date.now() });
      } catch (error) {
        console.error("Answer storage failed:", error);
        return json({ type: "error", message: "Failed to submit answer. Please try again." }, { status: 500 });
      }
    } catch (error) {
      console.error("Answer submission error:", error);
      return json({ error: "Invalid request" }, { status: 400 });
    }
  }
  broadcast(msg) {
    this.broadcastToAdmins(msg);
    this.broadcastToPlayers(this.filterMessageForPlayers(msg));
  }
  // Filter sensitive information from messages sent to players
  filterMessageForPlayers(msg) {
    if (msg.type === "result") {
      return {
        type: "result",
        questionId: msg.questionId,
        correct_option_id: msg.correct_option_id
      };
    }
    return msg;
  }
  broadcastToAdmins(msg) {
    const payload = JSON.stringify(msg);
    let successCount = 0;
    let failureCount = 0;
    for (const c of this.clients) {
      if (c.ws && c.isAdmin) {
        try {
          c.ws.send(payload);
          successCount++;
        } catch (error) {
          failureCount++;
          console.warn("Failed to send message to admin WebSocket client:", error);
          this.clients.delete(c);
        }
      }
    }
    for (const conn of this.sseConnections) {
      if (conn.isAdmin) {
        try {
          this.sendSSEMessage(conn.controller, msg, msg.type || "message");
          successCount++;
        } catch (error) {
          failureCount++;
          console.warn("Failed to send SSE message to admin:", error);
        }
      }
    }
    if (failureCount > 0) {
      console.log(`Admin Broadcast: ${successCount} sent, ${failureCount} failed`);
    }
  }
  broadcastToPlayers(msg) {
    const payload = JSON.stringify(msg);
    let successCount = 0;
    let failureCount = 0;
    for (const c of this.clients) {
      if (c.ws && !c.isAdmin) {
        try {
          c.ws.send(payload);
          successCount++;
        } catch (error) {
          failureCount++;
          console.warn("Failed to send message to player WebSocket client:", error);
          this.clients.delete(c);
        }
      }
    }
    for (const conn of this.sseConnections) {
      if (!conn.isAdmin) {
        try {
          this.sendSSEMessage(conn.controller, msg, msg.type || "message");
          successCount++;
        } catch (error) {
          failureCount++;
          console.warn("Failed to send SSE message to player:", error);
        }
      }
    }
    if (failureCount > 0) {
      console.log(`Player Broadcast: ${successCount} sent, ${failureCount} failed`);
    }
  }
  // Send SSE message to a specific controller
  sendSSEMessage(controller, data, eventType = "message") {
    const eventId = Date.now().toString();
    const message = `id: ${eventId}
event: ${eventType}
data: ${JSON.stringify(data)}

`;
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(message));
  }
  // Get current question for SSE connections
  async getCurrentQuestion() {
    if (!this.currentQuestionId) {
      return null;
    }
    try {
      const question = await this.loadQuestionById(this.currentQuestionId);
      return question;
    } catch (error) {
      console.error("Error loading current question:", error);
      return {
        id: this.currentQuestionId,
        text: "Loading question...",
        options: []
      };
    }
  }
  async loadQuestionById(questionId) {
    try {
      const questionRow = await this.env.DB.prepare(
        "SELECT q.id, q.text, q.correct_option_id, q.position FROM questions q WHERE q.id = ? AND q.room_code = ?"
      ).bind(questionId, this.code).first();
      if (!questionRow) return null;
      const opts = await this.env.DB.prepare("SELECT id, text FROM options WHERE question_id = ?").bind(questionId).all();
      return {
        id: questionRow.id,
        text: questionRow.text,
        correct_option_id: questionRow.correct_option_id,
        options: opts.results || [],
        position: questionRow.position
      };
    } catch (error) {
      console.error("Error loading question by ID:", error);
      return null;
    }
  }
  cleanupStaleConnections() {
    const staleClients = [];
    for (const client of this.clients) {
      if (client.ws && (client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING)) {
        staleClients.push(client);
      }
    }
    for (const client of staleClients) {
      this.clients.delete(client);
      if (client.playerId && this.present.has(client.playerId)) {
        this.present.delete(client.playerId);
      }
    }
    const staleSSE = [];
    for (const conn of this.sseConnections) {
      try {
        this.sendSSEMessage(conn.controller, { type: "ping" }, "ping");
      } catch (error) {
        staleSSE.push(conn);
      }
    }
    for (const conn of staleSSE) {
      this.sseConnections.delete(conn);
      if (conn.playerId && this.present.has(conn.playerId)) {
        this.present.delete(conn.playerId);
      }
    }
    if (staleClients.length > 0 || staleSSE.length > 0) {
      console.log(`Cleaned up ${staleClients.length} stale WebSocket and ${staleSSE.length} SSE connections`);
      this.broadcast({ type: "presence", count: this.present.size });
    }
  }
  async persist() {
    await this.state.storage.put("room", {
      code: this.code,
      currentIndex: this.currentIndex,
      currentQuestionId: this.currentQuestionId,
      currentStartMs: this.currentStartMs,
      collecting: this.collecting
    });
  }
  async loadNextQuestion() {
    const { results } = await this.env.DB.prepare(
      "SELECT q.id, q.text, q.correct_option_id FROM questions q WHERE q.room_code = ? ORDER BY position ASC"
    ).bind(this.code).all();
    this.currentIndex += 1;
    if (!results || this.currentIndex >= results.length) {
      return null;
    }
    const row = results[this.currentIndex];
    const opts = await this.env.DB.prepare("SELECT id, text FROM options WHERE question_id = ?").bind(row.id).all();
    return {
      id: row.id,
      text: row.text,
      correct_option_id: row.correct_option_id,
      options: opts.results || [],
      position: this.currentIndex
    };
  }
  async hasAnswered(qid, playerId) {
    try {
      const result = await this.env.DB.prepare(
        "SELECT 1 FROM answers WHERE room_code = ? AND question_id = ? AND player_id = ? LIMIT 1"
      ).bind(this.code, qid, playerId).first();
      return !!result;
    } catch (error) {
      console.error("Error checking if answered:", error);
      return false;
    }
  }
  async storeAnswer(qid, playerId, optionId) {
    const aid = crypto.randomUUID();
    const timestamp = Date.now();
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.env.DB.prepare(
          "INSERT OR IGNORE INTO answers (id, room_code, question_id, player_id, option_id, first_flag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(aid, this.code, qid, playerId, optionId, 0, timestamp).run();
        if (!result.success) {
          throw new Error("Database insert failed");
        }
        return;
      } catch (error) {
        console.error(`Answer storage attempt ${attempt} failed:`, error);
        if (attempt === maxRetries) {
          throw new Error("Failed to submit answer after multiple attempts");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100));
      }
    }
  }
  // 25-second window ends here - heavily optimized for massive concurrent load
  async alarm() {
    if (!this.collecting || !this.currentQuestionId) return;
    this.collecting = false;
    const qid = this.currentQuestionId;
    const processingStart = Date.now();
    try {
      const [qRow, ans] = await Promise.all([
        // Get correct answer
        this.env.DB.prepare(
          "SELECT correct_option_id FROM questions WHERE id = ? AND room_code = ?"
        ).bind(qid, this.code).first(),
        // Get all answers with player info (optimized with indexes)
        this.env.DB.prepare(
          "SELECT a.player_id, a.option_id, a.created_at, p.name, p.email FROM answers a JOIN players p ON a.player_id = p.id WHERE a.room_code = ? AND a.question_id = ? ORDER BY a.created_at ASC LIMIT 10000"
          // Prevent runaway queries
        ).bind(this.code, qid).all()
      ]);
      const storedCorrect = qRow?.correct_option_id ?? null;
      const correctIds = /* @__PURE__ */ new Set();
      if (storedCorrect) {
        correctIds.add(storedCorrect);
        if (!storedCorrect.includes(":")) correctIds.add(`${qid}:${storedCorrect}`);
      }
      const start = this.currentStartMs;
      const allAnswers = ans.results || [];
      const correct = allAnswers.filter((r) => correctIds.has(r.option_id));
      const awards = [];
      for (let i = 0; i < correct.length; i++) {
        const r = correct[i];
        const ms = r.created_at - start;
        const points = i < RANK_POINTS.length ? RANK_POINTS[i] : MIN_POINTS_FOR_CORRECT;
        awards.push({ player_id: r.player_id, name: r.name || "Player", email: r.email || "", ms, points });
      }
      if (awards.length > 0) {
        const pointGroups = /* @__PURE__ */ new Map();
        for (const a of awards) {
          if (!pointGroups.has(a.points)) {
            pointGroups.set(a.points, []);
          }
          pointGroups.get(a.points).push(a.player_id);
        }
        const updatePromises = Array.from(pointGroups.entries()).map(async ([points, playerIds]) => {
          const placeholders = playerIds.map(() => "?").join(",");
          const maxRetries = 3;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              await this.env.DB.prepare(
                `UPDATE players SET score = score + ? WHERE id IN (${placeholders})`
              ).bind(points, ...playerIds).run();
              break;
            } catch (error) {
              console.error(`Score update attempt ${attempt} failed:`, error);
              if (attempt === maxRetries) {
                throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, attempt * 100));
            }
          }
        });
        await Promise.all(updatePromises);
      }
      const leaderboard = awards.slice(0, 50).map((a, idx) => ({
        // Limit to top 50 for performance
        rank: idx + 1,
        name: a.name,
        email: a.email,
        ms: a.ms,
        points: a.points
      }));
      const processingTime = Date.now() - processingStart;
      this.broadcast({
        type: "result",
        questionId: qid,
        correct_option_id: storedCorrect,
        leaderboard,
        stats: {
          totalAnswers: allAnswers.length,
          correctAnswers: correct.length,
          processingTimeMs: processingTime,
          connectedClients: this.clients.size + this.sseConnections.size
        }
      });
      await this.persist();
      if (processingTime > 1e3) {
        console.warn(`Slow alarm processing: ${processingTime}ms for ${allAnswers.length} answers`);
      }
    } catch (error) {
      console.error("Critical error in alarm processing:", error);
      this.broadcast({
        type: "error",
        message: "Error processing question results. Please refresh if issues persist.",
        questionId: qid
      });
    }
  }
};

// C:/Users/palsh/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/palsh/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-nOvJ93/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// C:/Users/palsh/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-nOvJ93/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
