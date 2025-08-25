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
      const pid = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO players (id, room_code, name, email, phone, score) VALUES (?, ?, ?, ?, ?, 0)"
      ).bind(pid, code, body.name || "", body.email || "", body.phone || "").run();
      return json({ id: pid, name: body.name || "", email: body.email || "", phone: body.phone || "" });
    }
    const win = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/winners$/);
    if (win && request.method === "GET") {
      const code = win[1];
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, score FROM players WHERE room_code = ? ORDER BY score DESC, id LIMIT 5"
      ).bind(code).all();
      return json(results || []);
    }
    const next = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/next$/);
    if (next && request.method === "POST") {
      const code = next[1];
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch("https://do/next", { method: "POST" });
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
      const q = await this.loadNextQuestion();
      this.collecting = false;
      if (!q) {
        this.currentQuestionId = null;
        this.currentStartMs = 0;
        await this.persist();
        this.broadcast({ type: "question", question: null });
        return json(null);
      }
      this.currentQuestionId = q.id;
      this.currentStartMs = Date.now();
      this.collecting = true;
      await this.state.storage.setAlarm(new Date(this.currentStartMs + 3e4));
      await this.persist();
      this.broadcast({ type: "question", question: q, deadline: this.currentStartMs + 3e4 });
      return json(q);
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
    const client = { ws };
    ws.accept();
    this.clients.add(client);
    ws.addEventListener("message", async (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "register") {
          client.playerId = data.playerId;
          client.isAdmin = !!data.isAdmin;
          ws.send(JSON.stringify({ type: "registered", ok: true }));
        } else if (data.type === "answer") {
          if (!this.collecting || !this.currentQuestionId) {
            ws.send(JSON.stringify({ type: "status", message: "Answer window closed." }));
            return;
          }
          const already = await this.hasAnswered(this.currentQuestionId, data.playerId);
          if (already) {
            ws.send(JSON.stringify({ type: "status", message: "Already answered." }));
            return;
          }
          await this.storeAnswer(this.currentQuestionId, data.playerId, data.optionId);
          ws.send(JSON.stringify({ type: "accepted", at: Date.now() }));
        }
      } catch (e) {
        try {
          ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) }));
        } catch {
        }
      }
    });
    ws.addEventListener("close", () => this.clients.delete(client));
  }
  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      try {
        c.ws.send(payload);
      } catch {
      }
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
    const { results } = await this.env.DB.prepare(
      "SELECT id FROM answers WHERE room_code = ? AND question_id = ? AND player_id = ? LIMIT 1"
    ).bind(this.code, qid, playerId).all();
    return !!(results && results.length);
  }
  async storeAnswer(qid, playerId, optionId) {
    const aid = crypto.randomUUID();
    await this.env.DB.prepare(
      "INSERT INTO answers (id, room_code, question_id, player_id, option_id, first_flag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(aid, this.code, qid, playerId, optionId, 0, Date.now()).run();
  }
  // 30-second window ends here
  async alarm() {
    if (!this.collecting || !this.currentQuestionId) return;
    this.collecting = false;
    const qid = this.currentQuestionId;
    const qRow = await this.env.DB.prepare(
      "SELECT correct_option_id FROM questions WHERE id = ? AND room_code = ?"
    ).bind(qid, this.code).first();
    const correctId = qRow?.correct_option_id ?? null;
    const ans = await this.env.DB.prepare(
      "SELECT a.player_id, a.option_id, a.created_at, p.name, p.email FROM answers a JOIN players p ON a.player_id = p.id WHERE a.room_code = ? AND a.question_id = ?"
    ).bind(this.code, qid).all();
    const start = this.currentStartMs;
    const correct = (ans.results || []).filter((r) => r.option_id === correctId);
    correct.sort((x, y) => x.created_at - start - (y.created_at - start));
    if (correct.length) {
      const ids = [...new Set(correct.map((r) => r.player_id))];
      for (const pid of ids) {
        await this.env.DB.prepare("UPDATE players SET score = score + 1 WHERE id = ?").bind(pid).run();
      }
    }
    const leaderboard = correct.map((r, i) => ({
      rank: i + 1,
      name: r.name || "Player",
      email: r.email || "",
      ms: r.created_at - start
    }));
    this.broadcast({
      type: "result",
      questionId: qid,
      correct_option_id: correctId,
      leaderboard
    });
    await this.persist();
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

// .wrangler/tmp/bundle-CH3QVl/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-CH3QVl/middleware-loader.entry.ts
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
