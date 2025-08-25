# Cloudflare Real-time Quiz System

A high-performance, scalable real-time quiz application built on Cloudflare Workers, Durable Objects, and D1 database. Supports 500+ concurrent users with real-time WebSocket communication and advanced scoring mechanisms.

## 🚀 Features

### Core Functionality
- **Real-time Quiz Sessions**: Live quiz rooms with instant question broadcasting
- **Advanced Scoring System**: Rank-based points (1st: 5pts, 2nd: 4pts, 3rd: 3pts, 4th: 2pts, 5th: 1pt, others: 1pt)
- **Concurrent User Support**: Optimized for 500+ simultaneous participants
- **Admin Control Panel**: Real-time participant monitoring and quiz management
- **Anti-cheat Measures**: One answer per player per question with duplicate prevention
- **Performance Monitoring**: Built-in metrics and connection management

### Technical Highlights
- **Serverless Architecture**: Cloudflare Workers with global edge deployment
- **Durable Objects**: WebSocket state management and real-time coordination
- **D1 Database**: SQLite-based persistence with optimized indexing
- **WebSocket Hibernation Ready**: Scalable connection management
- **Rate Limiting**: Answer submission protection (3 attempts per question)
- **Error Recovery**: Retry logic and graceful degradation

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Static Files  │    │ Cloudflare Worker│    │  Durable Object │
│   (HTML/CSS/JS) │◄──►│   (API Routes)   │◄──►│   (WebSockets)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        │
                       ┌─────────────────┐               │
                       │   D1 Database   │◄──────────────┘
                       │   (SQLite)      │
                       └─────────────────┘
```

### Components Overview

#### 1. Cloudflare Worker (`src/index.ts`)
- **API Endpoints**: Room creation, player registration, participant management
- **Static Asset Serving**: HTML pages for admin and player interfaces
- **Request Routing**: WebSocket upgrade handling and API route management

#### 2. Durable Objects (`Room` class)
- **WebSocket Management**: Real-time communication with 1000+ connection limit
- **Quiz State**: Question progression, timing, and answer collection
- **Scoring Engine**: Rank-based point calculation and leaderboard generation
- **Performance Optimization**: Batch processing and connection cleanup

#### 3. D1 Database Schema
- **Rooms**: Quiz session metadata
- **Players**: Participant information and scores
- **Questions**: Quiz content with positioning
- **Options**: Multiple choice answers
- **Answers**: Response tracking with timestamps

## 🛠️ Installation & Setup

### Prerequisites
- Node.js 18+ and npm
- Cloudflare account with Workers and D1 access
- Wrangler CLI installed globally

### Quick Start

1. **Clone and Install Dependencies**
   ```bash
   git clone <repository-url>
   cd cloudflare-realtime-quiz
   npm install
   ```

2. **Install Wrangler CLI**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Create D1 Database**
   ```bash
   wrangler d1 create QUIZ_DB
   ```
   Copy the `database_id` from output and update `wrangler.toml`:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "QUIZ_DB"
   database_id = "your-database-id-here"
   ```

4. **Run Database Migrations**
   ```bash
   # Local development
   wrangler d1 migrations apply QUIZ_DB --local
   
   # Production deployment
   wrangler d1 migrations apply QUIZ_DB
   ```

5. **Development Mode**
   ```bash
   npm run dev
   ```
   Open http://127.0.0.1:8787/ to access the quiz creator

6. **Production Deployment**
   ```bash
   npm run deploy
   ```

## 📊 Database Schema

### Tables Structure

```sql
-- Quiz rooms with unique codes
CREATE TABLE rooms (
  code TEXT PRIMARY KEY,        -- 5-character room code (e.g., "ABC23")
  created_at INTEGER           -- Unix timestamp
);

-- Registered players
CREATE TABLE players (
  id TEXT PRIMARY KEY,         -- UUID
  room_code TEXT NOT NULL,     -- References rooms(code)
  name TEXT,                   -- Player display name
  email TEXT,                  -- Contact information
  phone TEXT,                  -- Optional phone number
  score INTEGER DEFAULT 0     -- Accumulated points
);

-- Quiz questions with positioning
CREATE TABLE questions (
  id TEXT PRIMARY KEY,         -- Prefixed format: "ROOM:questionId"
  room_code TEXT NOT NULL,     -- Room association
  text TEXT NOT NULL,          -- Question content
  correct_option_id TEXT,      -- Prefixed format: "ROOM:qId:optionId"
  position INTEGER            -- Question order (0-based)
);

-- Multiple choice options
CREATE TABLE options (
  id TEXT PRIMARY KEY,         -- Prefixed format: "ROOM:qId:optionId"
  question_id TEXT NOT NULL,   -- References questions(id)
  text TEXT NOT NULL          -- Option text
);

-- Player answers with timing
CREATE TABLE answers (
  id TEXT PRIMARY KEY,         -- UUID
  room_code TEXT NOT NULL,     -- Room association
  question_id TEXT NOT NULL,   -- Prefixed question ID
  player_id TEXT NOT NULL,     -- Player UUID
  option_id TEXT NOT NULL,     -- Prefixed option ID
  first_flag INTEGER DEFAULT 0, -- Reserved for future use
  created_at INTEGER          -- Unix timestamp (milliseconds)
);
```

### Performance Indexes

```sql
-- Player lookups by room
CREATE INDEX idx_players_room_code ON players(room_code);
CREATE INDEX idx_players_room_score ON players(room_code, score DESC);

-- Question ordering
CREATE INDEX idx_questions_room_position ON questions(room_code, position);

-- Option lookups
CREATE INDEX idx_options_question_id ON options(question_id);

-- Answer processing (critical for high-load scenarios)
CREATE INDEX idx_answers_room_question ON answers(room_code, question_id);
CREATE INDEX idx_answers_room_question_created ON answers(room_code, question_id, created_at);

-- Duplicate prevention
CREATE UNIQUE INDEX uniq_answer_per_q ON answers(room_code, question_id, player_id);
```

## 🔌 API Reference

### Room Management

#### Create Quiz Room
```http
POST /api/room
Content-Type: application/json

[
  {
    "id": "q1",
    "text": "What is the capital of France?",
    "correct_option_id": "o2",
    "options": [
      {"id": "o1", "text": "London"},
      {"id": "o2", "text": "Paris"},
      {"id": "o3", "text": "Berlin"},
      {"id": "o4", "text": "Madrid"}
    ]
  }
]
```

**Response:**
```json
{"code": "ABC23"}
```

#### Register Player
```http
POST /api/room/{CODE}/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+1234567890"
}
```

**Response:**
```json
{
  "id": "uuid-player-id",
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+1234567890"
}
```

#### Get Participants
```http
GET /api/room/{CODE}/participants?limit=250&offset=0
```

**Response:**
```json
{
  "total": 150,
  "items": [
    {
      "id": "uuid",
      "name": "John Doe",
      "email": "john@example.com",
      "score": 12
    }
  ]
}
```

#### Get Winners (Top 5)
```http
GET /api/room/{CODE}/winners
```

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "Winner 1",
    "email": "winner@example.com",
    "score": 25
  }
]
```

#### Start Next Question (Admin)
```http
POST /api/room/{CODE}/next
```

**Response:**
```json
{
  "ok": true,
  "questionId": "ABC23:q1",
  "connectedClients": 42,
  "deadline": 1640995200000
}
```

### WebSocket Connection

#### Connect to Room
```javascript
const ws = new WebSocket(`wss://your-worker.your-subdomain.workers.dev/ws/{CODE}`);

// Register as player
ws.send(JSON.stringify({
  type: "register",
  playerId: "uuid-player-id",
  player: {
    id: "uuid-player-id",
    name: "John Doe",
    email: "john@example.com"
  }
}));

// Register as admin
ws.send(JSON.stringify({
  type: "register",
  isAdmin: true
}));

// Submit answer
ws.send(JSON.stringify({
  type: "answer",
  playerId: "uuid-player-id",
  optionId: "ABC23:q1:o2"
}));

// Heartbeat
ws.send(JSON.stringify({type: "ping"}));
```

### WebSocket Messages

#### Server → Client Messages

**Question Broadcast:**
```json
{
  "type": "question",
  "question": {
    "id": "ABC23:q1",
    "text": "What is the capital of France?",
    "options": [
      {"id": "ABC23:q1:o1", "text": "London"},
      {"id": "ABC23:q1:o2", "text": "Paris"}
    ],
    "position": 0
  },
  "deadline": 1640995225000,
  "totalConnections": 42
}
```

**Results with Leaderboard:**
```json
{
  "type": "result",
  "questionId": "ABC23:q1",
  "correct_option_id": "ABC23:q1:o2",
  "leaderboard": [
    {
      "rank": 1,
      "name": "Speed Demon",
      "email": "fast@example.com",
      "ms": 1230,
      "points": 5
    }
  ],
  "stats": {
    "totalAnswers": 38,
    "correctAnswers": 22,
    "processingTimeMs": 145,
    "connectedClients": 42
  }
}
```

**Presence Updates:**
```json
{
  "type": "presence",
  "count": 42
}
```

**Error Handling:**
```json
{
  "type": "error",
  "message": "You have already answered this question."
}
```

## 🎯 User Interfaces

### Quiz Creator (`/index.html`)
- **Tabbed Interface**: Question creation, room management, settings
- **Question Builder**: Rich form with multiple choice options
- **Bulk Import**: JSON format for batch question creation
- **Preview Mode**: Test questions before room creation

### Player Interface (`/play.html`)
- **Room Join**: Enter code and player information
- **Real-time Questions**: Live question display with countdown
- **Answer Selection**: Touch-friendly option buttons
- **Results Display**: Instant feedback and leaderboard
- **Responsive Design**: Mobile-optimized layout

### Admin Console (`/admin.html`)
- **Live Statistics**: Connected players, question progress
- **Participant Management**: Real-time player list with pagination
- **Quiz Control**: Next question, session management
- **Performance Monitoring**: Connection stats, processing times
- **Leaderboard Display**: Top performers with detailed metrics

## ⚡ Performance Optimizations

### Connection Management
- **Connection Limits**: 1000 concurrent WebSocket connections per Durable Object
- **Cleanup Automation**: Periodic removal of stale connections (every 60 seconds)
- **Heartbeat System**: Ping/pong to maintain connection health
- **Graceful Degradation**: Error handling for connection failures

### Database Optimizations
- **Composite Indexes**: Optimized for high-frequency queries
- **Batch Operations**: Grouped updates for score calculations
- **Query Limits**: Prevent runaway queries (10,000 answer limit)
- **Retry Logic**: Exponential backoff for failed operations

### Answer Processing Pipeline
```
Answer Submission → Rate Limiting → Duplicate Check → Store Answer
                                                          ↓
25-Second Timer → Batch Score Calculation → Leaderboard Generation → Broadcast Results
```

### Scoring Algorithm
```javascript
// Rank-based scoring with time consideration
const RANK_POINTS = [5, 4, 3, 2, 1]; // 1st through 5th place
const MIN_POINTS_FOR_CORRECT = 1;     // Others who got it right

// Points awarded based on answer submission order
const points = rank < RANK_POINTS.length ? RANK_POINTS[rank] : MIN_POINTS_FOR_CORRECT;
```

## 🔒 Security Features

### Rate Limiting
- **Answer Attempts**: Maximum 3 submissions per player per question
- **Connection Limits**: 1000 WebSocket connections per room
- **Request Validation**: Input sanitization and type checking

### Data Integrity
- **Unique Constraints**: One answer per player per question
- **Prefixed IDs**: Namespace collision prevention
- **Transaction Safety**: ACID compliance for critical operations

### Error Handling
- **Graceful Failures**: Non-blocking error recovery
- **User Feedback**: Clear error messages for client issues
- **Monitoring**: Comprehensive logging for debugging

## 📈 Scalability Considerations

### Horizontal Scaling
- **Cloudflare Edge**: Global distribution and caching
- **Durable Objects**: Regional partitioning for reduced latency
- **D1 Database**: Automatic scaling and replication

### Performance Monitoring
- **Connection Metrics**: Real-time tracking of active connections
- **Processing Times**: Answer processing and broadcast latency
- **Error Rates**: Failed operations and recovery statistics

### Load Testing Results
- **Peak Capacity**: 500+ concurrent users verified
- **Response Times**: Sub-100ms question broadcasts
- **Answer Processing**: <500ms for 500 simultaneous submissions

## 🛠️ Development

### Local Development
```bash
# Start development server
npm run dev

# Apply migrations locally
npm run migrate:local

# Deploy to production
npm run deploy
```

### Environment Configuration
```toml
# wrangler.toml
name = "realtime-quiz-worker"
main = "src/index.ts"
compatibility_date = "2024-11-12"

[durable_objects]
bindings = [{ name = "ROOM", class_name = "Room" }]

[[d1_databases]]
binding = "DB"
database_name = "QUIZ_DB"
database_id = "your-database-id"
```

### Debugging
- **Wrangler Logs**: `wrangler tail` for real-time log monitoring
- **Local D1**: `wrangler d1 execute QUIZ_DB --local --command="SELECT * FROM rooms"`
- **WebSocket Testing**: Browser DevTools Network tab for connection inspection

## 📚 Additional Documentation

- **[Performance Analysis](document/PERFORMANCE.md)**: Detailed performance metrics and optimizations
- **[Scaling Audit](document/SCALE_AUDIT.md)**: Capacity planning and load testing results
- **[Load Testing Guide](document/LOAD_TESTING.md)**: Testing procedures and benchmarks
- **[Improvement Roadmap](document/IMPROVEMENTS.md)**: Future enhancements and features

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Run tests: `npm test` (if available)
4. Commit changes: `git commit -am 'Add new feature'`
5. Push to branch: `git push origin feature/new-feature`
6. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For issues and questions:
1. Check the documentation in the `document/` folder
2. Review existing GitHub issues
3. Create a new issue with detailed reproduction steps
4. Include relevant logs and error messages

## 🚀 Quick Demo

1. **Create a Quiz Room**:
   - Visit the deployed Worker URL
   - Add questions using the quiz creator
   - Click "Create Room" and note the 5-character code

2. **Join as Player**:
   - Visit `/play.html?code=YOUR_CODE`
   - Enter player information
   - Wait for questions to start

3. **Admin Control**:
   - Visit `/admin.html?code=YOUR_CODE`
   - Monitor live participants
   - Start questions with "Next Question" button

4. **View Results**:
   - Real-time leaderboard updates
   - Instant answer feedback
   - Final rankings and statistics

---

**Built with ❤️ using Cloudflare Workers, Durable Objects, and D1 Database**
