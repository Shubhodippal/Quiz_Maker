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
      
      // Validate required fields
      if (!body.name || body.name.trim().length === 0) {
        return json({ error: "Name is required" }, { status: 400 });
      }
      
      if (!body.email || body.email.trim().length === 0) {
        return json({ error: "Email is required" }, { status: 400 });
      }
      
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.email.trim())) {
        return json({ error: "Please provide a valid email address" }, { status: 400 });
      }
      
      if (!body.phone || body.phone.trim().length === 0) {
        return json({ error: "Phone number is required" }, { status: 400 });
      }
      
      // Basic phone validation (at least 10 digits)
      const phoneDigits = body.phone.trim().replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        return json({ error: "Please provide a valid phone number with at least 10 digits" }, { status: 400 });
      }

      const name = body.name.trim();
      const email = body.email.trim().toLowerCase();
      const phone = body.phone.trim();

      // Check if player is banned from this room (by email, phone, or combination)
      try {
        const banCheck = await env.DB.prepare(
          `SELECT id FROM banned_players 
           WHERE room_code = ? AND (
             player_email = ? OR 
             player_phone = ? OR 
             (player_email = ? AND player_phone = ?)
           )`
        ).bind(code, email, phone, email, phone).first();

        if (banCheck) {
          return json({ error: "You have been banned from this quiz room due to excessive warnings." }, { status: 403 });
        }
      } catch (error) {
        console.error("Ban check error:", error);
        // Continue with registration if ban check fails (fail-safe approach)
      }
      
      const pid = crypto.randomUUID();
      
      await env.DB.prepare(
        "INSERT INTO players (id, room_code, name, email, phone, score) VALUES (?, ?, ?, ?, ?, 0)"
      )
        .bind(pid, code, name, email, phone)
        .run();
      return json({ id: pid, name, email, phone });
    }

    // Check ban status for a player (for session restoration)
    const banCheck = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/ban-check$/);
    if (banCheck && request.method === "POST") {
      const code = banCheck[1];
      const body = (await request.json()) as { playerId?: string; email?: string; phone?: string };
      
      if (!body.playerId && !body.email && !body.phone) {
        return json({ error: "Player ID, email, or phone is required" }, { status: 400 });
      }

      try {
        let query = `SELECT id, ban_reason, banned_at FROM banned_players WHERE room_code = ?`;
        let params = [code];

        if (body.playerId) {
          query += ` AND player_id = ?`;
          params.push(body.playerId);
        } else {
          query += ` AND (player_email = ? OR player_phone = ?)`;
          params.push(body.email || '', body.phone || '');
        }

        const banRecord = await env.DB.prepare(query).bind(...params).first();

        if (banRecord) {
          return json({ 
            banned: true, 
            reason: banRecord.ban_reason || 'excessive_warnings',
            banned_at: banRecord.banned_at 
          });
        } else {
          return json({ banned: false });
        }
      } catch (error) {
        console.error("Ban check error:", error);
        return json({ error: "Failed to check ban status" }, { status: 500 });
      }
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
        "SELECT id, name, email, phone, score FROM players WHERE room_code = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?"
      ).bind(code, limit, offset).all();
      return json({ total: totalRow?.c || 0, items: results || [] });
    }

    // Top 50 winners with warning counts
    const win = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/winners$/);
    if (win && request.method === "GET") {
      const code = win[1];
      try {
        // Get top 50 players with their warning counts
        const { results } = await env.DB.prepare(
          `SELECT 
             p.id, 
             p.name, 
             p.email, 
             p.phone, 
             p.score,
             COALESCE(SUM(pw.warning_count), 0) as warning_count,
             CASE WHEN bp.player_id IS NOT NULL THEN 1 ELSE 0 END as is_banned
           FROM players p 
           LEFT JOIN player_warnings pw ON p.id = pw.player_id AND p.room_code = pw.room_code
           LEFT JOIN banned_players bp ON p.id = bp.player_id AND p.room_code = bp.room_code
           WHERE p.room_code = ? 
           GROUP BY p.id, p.name, p.email, p.phone, p.score, bp.player_id
           ORDER BY p.score DESC, p.id 
           LIMIT 50`
        ).bind(code).all();
        return json(results || []);
      } catch (error) {
        console.error("Error fetching winners with warnings:", error);
        // Fallback to original query if there's an issue
        const { results } = await env.DB.prepare(
          "SELECT id, name, email, phone, score, 0 as warning_count, 0 as is_banned FROM players WHERE room_code = ? ORDER BY score DESC, id LIMIT 50"
        ).bind(code).all();
        return json(results || []);
      }
    }

    // Warning and ban statistics (admin endpoint)
    const warnings = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/warnings$/);
    if (warnings && request.method === "GET") {
      const code = warnings[1];
      try {
        // Get active warnings grouped by player
        const { results: warningResults } = await env.DB.prepare(
          `SELECT 
             pw.player_id, 
             p.name, 
             p.email, 
             p.phone,
             SUM(pw.warning_count) as total_warnings,
             MAX(pw.created_at) as last_warning_at
           FROM player_warnings pw 
           JOIN players p ON pw.player_id = p.id 
           WHERE pw.room_code = ? 
           GROUP BY pw.player_id, p.name, p.email, p.phone
           ORDER BY total_warnings DESC, last_warning_at DESC`
        ).bind(code).all();

        // Get banned players
        const { results: bannedResults } = await env.DB.prepare(
          `SELECT 
             bp.player_id, 
             p.name, 
             bp.player_email, 
             bp.player_phone,
             bp.warning_count,
             bp.banned_at,
             bp.ban_reason
           FROM banned_players bp 
           LEFT JOIN players p ON bp.player_id = p.id 
           WHERE bp.room_code = ? 
           ORDER BY bp.banned_at DESC`
        ).bind(code).all();

        return json({
          warnings: warningResults || [],
          banned: bannedResults || []
        });
      } catch (error) {
        console.error("Error fetching warning statistics:", error);
        return json({ error: "Failed to fetch warning statistics" }, { status: 500 });
      }
    }

    // Get all questions for admin preview
    const questions = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/questions$/);
    if (questions && request.method === "GET") {
      const code = questions[1];
      try {
        const { results: questionResults } = await env.DB.prepare(
          "SELECT q.id, q.text, q.correct_option_id, q.position FROM questions q WHERE q.room_code = ? ORDER BY position ASC"
        ).bind(code).all();

        const questionsWithOptions = await Promise.all(
          (questionResults || []).map(async (q: any) => {
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

    // Admin Next -> DO decides and broadcasts
    const next = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/next$/);
    if (next && request.method === "POST") {
      const code = next[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch("https://do/next", { method: "POST" });
    }

    // SSE Stream endpoint for real-time updates
    const stream = url.pathname.match(/^\/stream\/([A-Z0-9]{5})$/);
    if (stream && request.method === "GET") {
      const code = stream[1];
      const id = env.ROOM.idFromName(code);
      
      // Forward to Durable Object with SSE-specific path
      const sseRequest = new Request("https://do/stream", {
        headers: {
          ...request.headers,
          "Accept": "text/event-stream"
        }
      });
      return env.ROOM.get(id).fetch(sseRequest);
    }

    // Answer submission endpoint (HTTP POST)
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

    // Warning submission endpoint (HTTP POST)
    const warningSubmit = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/warning$/);
    if (warningSubmit && request.method === "POST") {
      const code = warningSubmit[1];
      const body = await request.json() as { 
        playerId: string; 
        warningType: string;
        playerEmail: string;
        playerPhone: string;
      };
      
      if (!body.playerId || !body.warningType || !body.playerEmail || !body.playerPhone) {
        return json({ error: "Missing required warning data" }, { status: 400 });
      }

      try {
        // Check if player is already banned
        const existingBan = await env.DB.prepare(
          `SELECT id FROM banned_players 
           WHERE room_code = ? AND (
             player_id = ? OR 
             player_email = ? OR 
             player_phone = ? OR 
             (player_email = ? AND player_phone = ?)
           )`
        ).bind(code, body.playerId, body.playerEmail, body.playerPhone, body.playerEmail, body.playerPhone).first();

        if (existingBan) {
          return json({ 
            type: "banned", 
            message: "You have been banned from this quiz room due to excessive warnings." 
          }, { status: 403 });
        }

        // Get current warning count for this player in this room
        const warningResult = await env.DB.prepare(
          `SELECT SUM(warning_count) as total_warnings FROM player_warnings 
           WHERE room_code = ? AND (
             player_id = ? OR 
             player_email = ? OR 
             player_phone = ? OR 
             (player_email = ? AND player_phone = ?)
           )`
        ).bind(code, body.playerId, body.playerEmail, body.playerPhone, body.playerEmail, body.playerPhone).first<any>();

        const currentWarnings = warningResult?.total_warnings || 0;
        const newWarningCount = currentWarnings + 1;

        // Insert warning record
        const warningId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO player_warnings (id, room_code, player_id, player_email, player_phone, warning_type, warning_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(warningId, code, body.playerId, body.playerEmail, body.playerPhone, body.warningType, 1, Date.now()).run();

        // Check if player should be banned (4 or more warnings)
        if (newWarningCount >= 4) {
          const banId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO banned_players (id, room_code, player_id, player_email, player_phone, ban_reason, warning_count, banned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(banId, code, body.playerId, body.playerEmail, body.playerPhone, "excessive_warnings", newWarningCount, Date.now()).run();

          // Notify the durable object about the ban
          const id = env.ROOM.idFromName(code);
          env.ROOM.get(id).fetch("https://do/ban", { 
            method: "POST", 
            body: JSON.stringify({ playerId: body.playerId }),
            headers: { "Content-Type": "application/json" }
          });

          return json({ 
            type: "banned", 
            warningCount: newWarningCount,
            message: "You have been banned from this quiz room due to excessive warnings." 
          });
        }

        return json({ 
          type: "warning", 
          warningCount: newWarningCount,
          message: `Warning ${newWarningCount}/4: Please keep the quiz tab active and visible.` 
        });

      } catch (error) {
        console.error("Warning system error:", error);
        return json({ error: "Failed to process warning" }, { status: 500 });
      }
    }

    // Admin stream endpoint
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

    // WebSocket fallback for legacy support
    const ws = url.pathname.match(/^\/ws\/([A-Z0-9]{5})$/);
    if (ws && request.headers.get("Upgrade") === "websocket") {
      const code = ws[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

type Client = { 
  ws?: WebSocket; 
  playerId?: string; 
  isAdmin?: boolean;
  // SSE-specific properties
  isSSE?: boolean;
  lastEventId?: string;
  controller?: ReadableStreamDefaultController;
};

type SSEConnection = {
  controller: ReadableStreamDefaultController;
  playerId?: string;
  isAdmin?: boolean;
  lastEventId: string;
  connectedAt: number;
};

export class Room {
  state: DurableObjectState;
  env: Env;

  code = "";
  clients: Set<Client> = new Set();
  sseConnections: Set<SSEConnection> = new Set();
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
          totalConnections: this.clients.size + this.sseConnections.size
        });
        
        await this.persist();
        return json({ 
          ok: true, 
          questionId: q.id, 
          connectedClients: this.clients.size + this.sseConnections.size,
          deadline: this.currentStartMs + 25_000
        });
      } catch (error) {
        console.error("Error in next question:", error);
        return json({ error: "Failed to load next question" }, { status: 500 });
      }
    }

    // SSE Stream endpoint
    if (url.pathname === "/stream" && request.headers.get("Accept")?.includes("text/event-stream")) {
      return this.handleSSEConnection(request, false);
    }

    // Admin SSE Stream endpoint
    if (url.pathname === "/admin/stream" && request.headers.get("Accept")?.includes("text/event-stream")) {
      return this.handleSSEConnection(request, true);
    }

    // Answer submission (HTTP POST)
    if (url.pathname === "/answer" && request.method === "POST") {
      return this.handleAnswerSubmission(request);
    }

    // Player ban notification (HTTP POST)
    if (url.pathname === "/ban" && request.method === "POST") {
      return this.handlePlayerBan(request);
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

  // SSE Connection Handler
  handleSSEConnection(request: Request, isAdmin: boolean): Response {
    // Connection limit protection
    if (this.sseConnections.size >= this.maxConnections) {
      return new Response("Server overloaded", { status: 503 });
    }

    const url = new URL(request.url);
    const lastEventId = request.headers.get("Last-Event-ID") || url.searchParams.get("lastEventId") || "0";
    const playerId = url.searchParams.get("playerId");

    let connectionClosed = false;

    const stream = new ReadableStream({
      start: async (controller) => {
        // Create SSE connection
        const connection: SSEConnection = {
          controller,
          playerId: playerId || undefined,
          isAdmin,
          lastEventId,
          connectedAt: Date.now()
        };

        this.sseConnections.add(connection);

        // Send initial connection confirmation
        this.sendSSEMessage(controller, {
          type: "connected",
          timestamp: Date.now(),
          connectedClients: this.clients.size + this.sseConnections.size
        }, "connected");

        // Track presence for players
        if (playerId && !isAdmin) {
          // We need to get player details from the database since SSE doesn't send them
          try {
            const playerRow = await this.env.DB.prepare(
              "SELECT name, email FROM players WHERE id = ? AND room_code = ?"
            ).bind(playerId, this.code).first<any>();
            
            if (playerRow) {
              this.present.set(playerId, {
                name: playerRow.name || "Player",
                email: playerRow.email || "",
              });
              // Broadcast presence update
              this.broadcast({ type: "presence", count: this.present.size });
            }
          } catch (error) {
            console.error("Error tracking presence for SSE player:", error);
          }
        }

        // Send current question if active
        if (this.collecting && this.currentQuestionId) {
          this.getCurrentQuestion().then(question => {
            if (question) {
              this.sendSSEMessage(controller, {
                type: "question",
                question: question,
                deadline: this.currentStartMs + 25_000
              }, "question");
            }
          }).catch(error => {
            console.error("Error sending current question to SSE client:", error);
          });
        }
      },
      cancel: () => {
        connectionClosed = true;
        // Find and remove the connection
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
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      },
    });
  }

  // Answer Submission Handler
  async handleAnswerSubmission(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { 
        playerId: string; 
        optionId: string 
      };

      // Enhanced rate limiting for answer submissions
      if (!this.collecting || !this.currentQuestionId) {
        return json({ type: "error", message: "Answer window closed." }, { status: 400 });
      }
      
      if (!body.playerId || !body.optionId) {
        return json({ type: "error", message: "Invalid answer data." }, { status: 400 });
      }
      
      // Rate limiting: max 3 attempts per player per question
      const attempts = this.answerAttempts.get(body.playerId) || 0;
      if (attempts >= 3) {
        return json({ type: "error", message: "Too many answer attempts." }, { status: 429 });
      }
      
      this.answerAttempts.set(body.playerId, attempts + 1);
      
      // Check for duplicate answers first (faster than database insert)
      const already = await this.hasAnswered(this.currentQuestionId, body.playerId);
      if (already) {
        return json({ type: "error", message: "You have already answered this question." }, { status: 409 });
      }
      
      // Store answer with error handling
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

  // Player Ban Handler
  async handlePlayerBan(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { playerId: string };
      
      if (!body.playerId) {
        return json({ error: "Missing player ID" }, { status: 400 });
      }

      // Remove player from presence tracking
      if (this.present.has(body.playerId)) {
        this.present.delete(body.playerId);
        this.broadcast({ type: "presence", count: this.present.size });
      }

      // Close all connections for this player
      for (const client of this.clients) {
        if (client.playerId === body.playerId) {
          if (client.ws) {
            client.ws.close(1000, "Player banned from quiz room");
          }
          this.clients.delete(client);
        }
      }

      // Close SSE connections for this player
      for (const conn of this.sseConnections) {
        if (conn.playerId === body.playerId) {
          try {
            this.sendSSEMessage(conn.controller, {
              type: "banned",
              message: "You have been banned from this quiz room due to excessive warnings."
            }, "banned");
            // Close the SSE connection
            conn.controller.close();
          } catch (error) {
            console.error("Error closing SSE connection for banned player:", error);
          }
          this.sseConnections.delete(conn);
        }
      }

      return json({ success: true, message: "Player banned successfully" });
    } catch (error) {
      console.error("Player ban error:", error);
      return json({ error: "Failed to ban player" }, { status: 500 });
    }
  }

  broadcast(msg: any) {
    // Send different messages to admins vs players
    this.broadcastToAdmins(msg);
    this.broadcastToPlayers(this.filterMessageForPlayers(msg));
  }

  // Filter sensitive information from messages sent to players
  filterMessageForPlayers(msg: any): any {
    if (msg.type === "result") {
      // Players only get the correct answer ID, no leaderboard or scores
      return {
        type: "result",
        questionId: msg.questionId,
        correct_option_id: msg.correct_option_id
      };
    }
    // All other message types are safe for players
    return msg;
  }

  broadcastToAdmins(msg: any) {
    const payload = JSON.stringify(msg);
    let successCount = 0;
    let failureCount = 0;
    
    // Broadcast to admin WebSocket clients
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
    
    // Broadcast to admin SSE clients
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

  broadcastToPlayers(msg: any) {
    const payload = JSON.stringify(msg);
    let successCount = 0;
    let failureCount = 0;
    
    // Broadcast to player WebSocket clients
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
    
    // Broadcast to player SSE clients
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
  sendSSEMessage(controller: ReadableStreamDefaultController, data: any, eventType: string = "message") {
    const eventId = Date.now().toString();
    const message = `id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(message));
  }

  // Get current question for SSE connections
  async getCurrentQuestion(): Promise<any> {
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

  async loadQuestionById(questionId: string): Promise<QuizQuestion | null> {
    try {
      const questionRow = await this.env.DB.prepare(
        "SELECT q.id, q.text, q.correct_option_id, q.position FROM questions q WHERE q.id = ? AND q.room_code = ?"
      ).bind(questionId, this.code).first<any>();
      
      if (!questionRow) return null;
      
      const opts = await this.env.DB.prepare("SELECT id, text FROM options WHERE question_id = ?")
        .bind(questionId)
        .all();

      return {
        id: questionRow.id,
        text: questionRow.text,
        correct_option_id: questionRow.correct_option_id,
        options: (opts.results as any[]) || [],
        position: questionRow.position,
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
    
    // Also cleanup stale SSE connections
    const staleSSE = [];
    for (const conn of this.sseConnections) {
      try {
        // Test if controller is still writable
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
          connectedClients: this.clients.size + this.sseConnections.size
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
