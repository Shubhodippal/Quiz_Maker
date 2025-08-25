# Real-time Quiz on Cloudflare Workers (Durable Objects + D1)

## What you get
- **Serverless** Worker with a **Durable Object** per room coordinating WebSockets.
- **D1** (SQLite) for rooms, players, questions, options, answers, scores.
- Static **admin** and **player** pages (served by Workers Assets).

## Quick start
1. Install Cloudflare CLI: `npm i -g wrangler`
2. Create D1: `wrangler d1 create QUIZ_DB`  
   Copy the `database_id` and replace it in `wrangler.toml`.
3. Apply schema: `wrangler d1 migrations apply QUIZ_DB --local` (for dev) then `wrangler d1 migrations apply QUIZ_DB` on deploy.
4. Dev: `npm install && npm run dev`
5. Open `http://127.0.0.1:8787/`

## API
- `POST /api/room` body: `[ { id, text, correct_option_id, options:[{id,text}] } ]` -> `{ code }`
- `POST /api/room/:CODE/next` -> broadcasts next question to room (`/ws/:CODE`)
- `POST /api/room/:CODE/register` body: `{ name,email,phone }` -> `{ id, ... }`
- `GET  /api/room/:CODE/winners` -> top 5 by score
- `WS  /ws/:CODE` -> messages:
  - client->server: `{type:'register', playerId?, isAdmin?}`
  - client->server: `{type:'answer', playerId, optionId}`
  - server->client: `{type:'question', question}` / `{type:'lock', locked:true|false}` / `{type:'first', playerId}`

## Implementation notes
- "First answer wins" handled atomically via Durable Object storage key `lock:index`.
- Scores persisted to D1, so `/winners` works even if the DO restarts.
- Use **WebSocketPair** in DO; for scale/cost use **WebSocket Hibernation** if needed.
