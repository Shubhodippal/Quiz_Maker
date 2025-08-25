export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
}

type QuizOption = { id: string; text: string };
type QuizQuestion = {
  id: string;                  // stored as ROOM:qId
  text: string;
  correct_option_id?: string;  // stored as ROOM:qId:oId (fallback handled)
  options: QuizOption[];       // option ids are ROOM:qId:oId
  position?: number;
};

function json(data: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** --- Scoring config ---
 * Rank-based points rewarding the fastest correct answers.
 * 1st: 5, 2nd: 4, 3rd: 3, 4th: 2, 5th: 1, all other correct: +1
 */
const RANK_POINTS = [5, 4, 3, 2, 1];
const MIN_POINTS_FOR_CORRECT = 1;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Create room with questions
    if (url.pathname === "/api/room" && request.method === "POST") {
      const raw: Array<{
        id: string;
        text: string;
        correct_option_id?: string;
        options: { id: string; text: string }[];
      }> = await request.json();

      const code = generateCode();
      await env.DB.prepare("INSERT INTO rooms (code, created_at) VALUES (?, ?)")
        .bind(code, Date.now())
        .run();

      // Insert questions/options with prefixed IDs (avoid collisions)
      let pos = 0;
      for (const q of raw) {
        const qid = `${code}:${q.id}`;
        const correctId = q.correct_option_id ? `${qid}:${q.correct_option_id}` : null;

        await env.DB.prepare(
          "INSERT INTO questions (id, room_code, text, correct_option_id, position) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(qid, code, q.text, correctId, pos++)
          .run();

        for (const o of q.options || []) {
          const oid = `${qid}:${o.id}`;
          await env.DB.prepare("INSERT INTO options (id, question_id, text) VALUES (?, ?, ?)")
            .bind(oid, qid, o.text)
            .run();
        }
      }

      // Warm up DO
      const id = env.ROOM.idFromName(code);
      await env.ROOM.get(id).fetch("https://do/bootstrap?code=" + code);

      return json({ code });
    }

    // Register player
    const reg = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/register$/);
    if (reg && request.method === "POST") {
      const code = reg[1];
      const body = (await request.json()) as { name?: string; email?: string; phone?: string };
      const pid = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO players (id, room_code, name, email, phone, score) VALUES (?, ?, ?, ?, ?, 0)"
      )
        .bind(pid, code, body.name || "", body.email || "", body.phone || "")
        .run();
      return json({ id: pid, name: body.name || "", email: body.email || "", phone: body.phone || "" });
    }

    // Participants list (admin panel)
    const plist = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/participants$/);
    if (plist && request.method === "GET") {
      const code = plist[1];
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "250", 10), 250);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM players WHERE room_code = ?"
      ).bind(code).first<any>();
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, score FROM players WHERE room_code = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?"
      ).bind(code, limit, offset).all();
      return json({ total: totalRow?.c || 0, items: results || [] });
    }

    // Top 5 winners
    const win = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/winners$/);
    if (win && request.method === "GET") {
      const code = win[1];
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, score FROM players WHERE room_code = ? ORDER BY score DESC, id LIMIT 5"
      ).bind(code).all();
      return json(results || []);
    }

    // Admin Next -> DO decides and broadcasts
    const next = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/next$/);
    if (next && request.method === "POST") {
      const code = next[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch("https://do/next", { method: "POST" });
    }

    // WebSocket to DO
    const ws = url.pathname.match(/^\/ws\/([A-Z0-9]{5})$/);
    if (ws && request.headers.get("Upgrade") === "websocket") {
      const code = ws[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

type Client = { ws: WebSocket; playerId?: string; isAdmin?: boolean };

export class Room {
  state: DurableObjectState;
  env: Env;

  code = "";
  clients: Set<Client> = new Set();
  present: Map<string, { name: string; email: string }> = new Map();
  
  // Connection management for high load
  maxConnections = 1000; // Increased limit for scalability
  connectionCounter = 0;
  lastCleanup = 0;
  
  // Rate limiting for answer submissions
  answerAttempts: Map<string, number> = new Map(); // playerId -> attempts count
  lastAnswerReset = 0;

  currentIndex = -1;
  currentQuestionId: string | null = null; // prefixed id
  currentStartMs = 0;
  collecting = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const data = await this.state.storage.get<any>("room");
      if (data) {
        this.code = data.code;
        this.currentIndex = data.currentIndex ?? -1;
        this.currentQuestionId = data.currentQuestionId ?? null;
        this.currentStartMs = data.currentStartMs ?? 0;
        this.collecting = !!data.collecting;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Bootstrap
    if (url.pathname === "/bootstrap") {
      this.code = url.searchParams.get("code") || this.code;
      await this.persist();
      return new Response("ok");
    }

    // Admin "next" — start 25s window and broadcast with enhanced error handling
    if (url.pathname === "/next" && request.method === "POST") {
      try {
        const q = await this.loadNextQuestion();
        if (!q) {
          return json({ error: "No more questions" });
        }

        this.currentQuestionId = q.id;
        this.currentStartMs = Date.now();
        this.collecting = true;

        // Reset rate limiting for new question
        this.answerAttempts.clear();
        this.lastAnswerReset = Date.now();

        // Set alarm for 25 seconds
        await this.state.storage.setAlarm(new Date(this.currentStartMs + 25_000));

        // Broadcast question with error handling
        const broadcastSuccess = this.broadcast({ 
          type: "question", 
          question: q, 
          deadline: this.currentStartMs + 25_000,
          totalConnections: this.clients.size
        });
        
        await this.persist();
        return json({ 
          ok: true, 
          questionId: q.id, 
          connectedClients: this.clients.size,
          deadline: this.currentStartMs + 25_000
        });
      } catch (error) {
        console.error("Error in next question:", error);
        return json({ error: "Failed to load next question" }, { status: 500 });
      }
    }

    // WebSocket
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  handleSession(ws: WebSocket) {
    // Connection limit protection
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, "Server overloaded");
      return;
    }

    const client: Client = { ws };
    ws.accept();
    this.clients.add(client);
    this.connectionCounter++;

    // Periodic cleanup of stale connections
    if (Date.now() - this.lastCleanup > 60000) { // Every minute
      this.cleanupStaleConnections();
      this.lastCleanup = Date.now();
    }

    ws.addEventListener("message", async (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        if (data.type === "register") {
          client.playerId = data.playerId;
          client.isAdmin = !!data.isAdmin;

          // If player identity provided, track presence
          if (data.player && data.player.id && !client.isAdmin) {
            this.present.set(data.player.id, {
              name: data.player.name || "Player",
              email: data.player.email || "",
            });
            this.broadcast({ type: "presence", count: this.present.size });
          }
          ws.send(JSON.stringify({ type: "registered", ok: true }));
        } else if (data.type === "answer") {
          // Enhanced rate limiting for answer submissions
          if (!this.collecting || !this.currentQuestionId) {
            ws.send(JSON.stringify({ type: "error", message: "Answer window closed." }));
            return;
          }
          if (!data.playerId || !data.optionId) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid answer data." }));
            return;
          }
          
          // Rate limiting: max 3 attempts per player per question
          const attempts = this.answerAttempts.get(data.playerId) || 0;
          if (attempts >= 3) {
            ws.send(JSON.stringify({ type: "error", message: "Too many answer attempts." }));
            return;
          }
          
          this.answerAttempts.set(data.playerId, attempts + 1);
          
          // Check for duplicate answers first (faster than database insert)
          const already = await this.hasAnswered(this.currentQuestionId, data.playerId);
          if (already) {
            ws.send(JSON.stringify({ type: "error", message: "You have already answered this question." }));
            return;
          }
          
          // Store answer with error handling
          try {
            await this.storeAnswer(this.currentQuestionId, data.playerId, data.optionId);
            ws.send(JSON.stringify({ type: "accepted", at: Date.now() }));
          } catch (error) {
            console.error("Answer storage failed:", error);
            ws.send(JSON.stringify({ type: "error", message: "Failed to submit answer. Please try again." }));
          }
        } else if (data.type === "ping") {
          // Heartbeat to keep connection alive
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (e: any) {
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

  broadcast(msg: any) {
    const payload = JSON.stringify(msg);
    let successCount = 0;
    let failureCount = 0;
    
    for (const c of this.clients) {
      try { 
        c.ws.send(payload);
        successCount++;
      } catch (error) {
        failureCount++;
        console.warn("Failed to send message to client:", error);
        // Remove failed connections
        this.clients.delete(c);
      }
    }
    
    // Log broadcast statistics for monitoring
    if (failureCount > 0) {
      console.log(`Broadcast: ${successCount} sent, ${failureCount} failed`);
    }
  }

  cleanupStaleConnections() {
    const staleClients = [];
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING) {
        staleClients.push(client);
      }
    }
    
    for (const client of staleClients) {
      this.clients.delete(client);
      if (client.playerId && this.present.has(client.playerId)) {
        this.present.delete(client.playerId);
      }
    }
    
    if (staleClients.length > 0) {
      console.log(`Cleaned up ${staleClients.length} stale connections`);
      this.broadcast({ type: "presence", count: this.present.size });
    }
  }

  async persist() {
    await this.state.storage.put("room", {
      code: this.code,
      currentIndex: this.currentIndex,
      currentQuestionId: this.currentQuestionId,
      currentStartMs: this.currentStartMs,
      collecting: this.collecting,
    });
  }

  async loadNextQuestion(): Promise<QuizQuestion | null> {
    const { results } = await this.env.DB.prepare(
      "SELECT q.id, q.text, q.correct_option_id FROM questions q WHERE q.room_code = ? ORDER BY position ASC"
    ).bind(this.code).all();

    this.currentIndex += 1;
    if (!results || this.currentIndex >= results.length) {
      return null;
    }

    const row = results[this.currentIndex] as any;
    const opts = await this.env.DB.prepare("SELECT id, text FROM options WHERE question_id = ?")
      .bind(row.id)
      .all();

    return {
      id: row.id,
      text: row.text,
      correct_option_id: row.correct_option_id,
      options: (opts.results as any[]) || [],
      position: this.currentIndex,
    };
  }

  async hasAnswered(qid: string, playerId: string): Promise<boolean> {
    try {
      // Optimized query using the new composite index
      const result = await this.env.DB.prepare(
        "SELECT 1 FROM answers WHERE room_code = ? AND question_id = ? AND player_id = ? LIMIT 1"
      ).bind(this.code, qid, playerId).first();
      return !!result;
    } catch (error) {
      console.error("Error checking if answered:", error);
      return false; // Fail safe - allow answer attempt
    }
  }

  async storeAnswer(qid: string, playerId: string, optionId: string) {
    const aid = crypto.randomUUID();
    const timestamp = Date.now();
    
    // Retry logic for database operations under high load
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use INSERT OR IGNORE to handle race conditions gracefully
        // The unique index will prevent duplicate answers
        const result = await this.env.DB.prepare(
          "INSERT OR IGNORE INTO answers (id, room_code, question_id, player_id, option_id, first_flag, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(aid, this.code, qid, playerId, optionId, 0, timestamp).run();
        
        // Check if the insert was successful using meta information
        if (!result.success) {
          throw new Error("Database insert failed");
        }
        
        return; // Success
      } catch (error) {
        console.error(`Answer storage attempt ${attempt} failed:`, error);
        
        if (attempt === maxRetries) {
          throw new Error("Failed to submit answer after multiple attempts");
        }
        
        // Exponential backoff before retry
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
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
      // Parallel execution of critical queries for performance
      const [qRow, ans] = await Promise.all([
        // Get correct answer
        this.env.DB.prepare(
          "SELECT correct_option_id FROM questions WHERE id = ? AND room_code = ?"
        ).bind(qid, this.code).first<any>(),
        
        // Get all answers with player info (optimized with indexes)
        this.env.DB.prepare(
          "SELECT a.player_id, a.option_id, a.created_at, p.name, p.email " +
          "FROM answers a JOIN players p ON a.player_id = p.id " +
          "WHERE a.room_code = ? AND a.question_id = ? " +
          "ORDER BY a.created_at ASC LIMIT 10000" // Prevent runaway queries
        ).bind(this.code, qid).all<any>()
      ]);

      // Accept both stored (prefixed) and raw fallback (e.g., 'o2') just in case
      const storedCorrect: string | null = qRow?.correct_option_id ?? null;
      const correctIds = new Set<string>();
      if (storedCorrect) {
        correctIds.add(storedCorrect);
        if (!storedCorrect.includes(":")) correctIds.add(`${qid}:${storedCorrect}`);
      }

      const start = this.currentStartMs;
      const allAnswers = ans.results || [];

      // Filter correct answers (already sorted by created_at ASC)
      const correct = allAnswers.filter((r: any) => correctIds.has(r.option_id));

      // Build awards with enhanced performance tracking
      const awards: Array<{ player_id: string; name: string; email: string; ms: number; points: number }> = [];
      for (let i = 0; i < correct.length; i++) {
        const r = correct[i];
        const ms = r.created_at - start;
        const points = i < RANK_POINTS.length ? RANK_POINTS[i] : MIN_POINTS_FOR_CORRECT;
        awards.push({ player_id: r.player_id, name: r.name || "Player", email: r.email || "", ms, points });
      }

      // Ultra-optimized batch scoring update
      if (awards.length > 0) {
        // Group by points for efficient batch processing
        const pointGroups = new Map<number, string[]>();
        for (const a of awards) {
          if (!pointGroups.has(a.points)) {
            pointGroups.set(a.points, []);
          }
          pointGroups.get(a.points)!.push(a.player_id);
        }

        // Execute all score updates in parallel with retry logic
        const updatePromises = Array.from(pointGroups.entries()).map(async ([points, playerIds]) => {
          const placeholders = playerIds.map(() => '?').join(',');
          const maxRetries = 3;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              await this.env.DB.prepare(
                `UPDATE players SET score = score + ? WHERE id IN (${placeholders})`
              ).bind(points, ...playerIds).run();
              break; // Success
            } catch (error) {
              console.error(`Score update attempt ${attempt} failed:`, error);
              if (attempt === maxRetries) {
                throw error;
              }
              await new Promise(resolve => setTimeout(resolve, attempt * 100));
            }
          }
        });

        await Promise.all(updatePromises);
      }

      // Generate optimized leaderboard
      const leaderboard = awards.slice(0, 50).map((a, idx) => ({ // Limit to top 50 for performance
        rank: idx + 1,
        name: a.name,
        email: a.email,
        ms: a.ms,
        points: a.points,
      }));

      const processingTime = Date.now() - processingStart;

      // Enhanced broadcast with performance metrics
      this.broadcast({
        type: "result",
        questionId: qid,
        correct_option_id: storedCorrect,
        leaderboard,
        stats: {
          totalAnswers: allAnswers.length,
          correctAnswers: correct.length,
          processingTimeMs: processingTime,
          connectedClients: this.clients.size
        }
      });

      await this.persist();
      
      // Performance monitoring
      if (processingTime > 1000) {
        console.warn(`Slow alarm processing: ${processingTime}ms for ${allAnswers.length} answers`);
      }
      
    } catch (error) {
      console.error("Critical error in alarm processing:", error);
      // Emergency broadcast to clients
      this.broadcast({
        type: "error",
        message: "Error processing question results. Please refresh if issues persist.",
        questionId: qid
      });
    }
  }
}
