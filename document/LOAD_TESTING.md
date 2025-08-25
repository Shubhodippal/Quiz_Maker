# Massive Load Testing Configuration

## Artillery.js Load Test Scripts

### 1. Connection Stress Test (1000 concurrent WebSocket connections)

```yaml
# ws-stress-test.yml
config:
  target: 'wss://your-worker.your-subdomain.workers.dev'
  phases:
    - duration: 30
      arrivalRate: 50
      name: "Ramp up to 1000 connections"
  ws:
    connect:
      timeout: 10
  plugins:
    metrics-by-endpoint: {}

scenarios:
  - name: "WebSocket Connection Stress"
    weight: 100
    engine: ws
    flow:
      - connect:
          url: "/ws/{{ roomCode }}"
      - think: 2
      - send:
          payload: '{"type":"register","playerId":"{{ $uuid() }}","player":{"id":"{{ $uuid() }}","name":"LoadTestUser{{ $randomInt(1,10000) }}"}}'
      - think: 30
      - send:
          payload: '{"type":"ping"}'
      - think: 60
```

### 2. Answer Submission Burst Test (500 simultaneous answers)

```yaml
# answer-burst-test.yml
config:
  target: 'wss://your-worker.your-subdomain.workers.dev'
  phases:
    - duration: 5
      arrivalRate: 100
      name: "500 users join"
    - duration: 25
      arrivalRate: 0
      name: "Wait for question"
    - duration: 5
      arrivalRate: 0
      name: "All submit answers simultaneously"

scenarios:
  - name: "Burst Answer Submission"
    weight: 100
    engine: ws
    flow:
      - connect:
          url: "/ws/{{ roomCode }}"
      - think: 1
      - send:
          payload: '{"type":"register","playerId":"user-{{ $uuid() }}","player":{"id":"user-{{ $uuid() }}","name":"BurstUser{{ $randomInt(1,1000) }}"}}'
      - think: 25
      - send:
          payload: '{"type":"answer","playerId":"user-{{ $uuid() }}","optionId":"{{ roomCode }}:q1:o{{ $randomInt(1,4) }}"}'
```

## Performance Monitoring Script

```javascript
// monitor-performance.js
const WebSocket = require('ws');

class QuizLoadMonitor {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.connections = [];
    this.metrics = {
      totalConnections: 0,
      failedConnections: 0,
      responseLatencies: [],
      answerSubmissions: 0,
      errors: []
    };
  }

  async createConnections(count) {
    console.log(`Creating ${count} WebSocket connections...`);
    
    const promises = Array.from({ length: count }, (_, i) => 
      this.createConnection(`user-${i}`, `TestUser${i}`)
    );

    await Promise.all(promises);
    console.log(`Successfully created ${this.metrics.totalConnections} connections`);
  }

  async createConnection(playerId, playerName) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://your-worker.workers.dev/ws/${this.roomCode}`);
      const startTime = Date.now();

      ws.on('open', () => {
        this.metrics.totalConnections++;
        
        // Register player
        ws.send(JSON.stringify({
          type: 'register',
          playerId: playerId,
          player: { id: playerId, name: playerName }
        }));

        this.connections.push({ ws, playerId, startTime });
        resolve();
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data);
        const latency = Date.now() - startTime;
        this.metrics.responseLatencies.push(latency);

        if (message.type === 'question') {
          // Simulate answer submission after random delay
          setTimeout(() => {
            this.submitAnswer(ws, playerId, message.question);
          }, Math.random() * 5000);
        }
      });

      ws.on('error', (error) => {
        this.metrics.failedConnections++;
        this.metrics.errors.push(error.message);
        reject(error);
      });
    });
  }

  submitAnswer(ws, playerId, question) {
    const randomOption = question.options[Math.floor(Math.random() * question.options.length)];
    const submission = {
      type: 'answer',
      playerId: playerId,
      optionId: randomOption.id
    };

    ws.send(JSON.stringify(submission));
    this.metrics.answerSubmissions++;
  }

  getMetrics() {
    const latencies = this.metrics.responseLatencies;
    return {
      totalConnections: this.metrics.totalConnections,
      failedConnections: this.metrics.failedConnections,
      answerSubmissions: this.metrics.answerSubmissions,
      avgLatency: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      maxLatency: Math.max(...latencies, 0),
      minLatency: Math.min(...latencies, Infinity),
      errors: this.metrics.errors
    };
  }
}

// Usage
async function runLoadTest() {
  const monitor = new QuizLoadMonitor('TEST1');
  
  try {
    await monitor.createConnections(1000);
    
    // Wait for test to complete
    setTimeout(() => {
      console.log('Load Test Results:', monitor.getMetrics());
    }, 60000);
    
  } catch (error) {
    console.error('Load test failed:', error);
  }
}

runLoadTest();
```

## Cloudflare Analytics Monitoring

### Key Metrics to Monitor:

1. **Request Volume**
   - Requests per second
   - Peak concurrent connections
   - Request success rate

2. **Database Performance**
   - D1 query execution time
   - Database connection pool usage
   - Failed query rate

3. **Durable Object Metrics**
   - Memory usage per room
   - CPU utilization during answer bursts
   - WebSocket connection count

4. **Error Rates**
   - WebSocket connection failures
   - Answer submission failures
   - Database timeout errors

### Wrangler Commands for Monitoring:

```bash
# View live logs during load test
npx wrangler tail

# Check D1 database stats
npx wrangler d1 info QUIZ_DB

# Monitor Durable Object usage
npx wrangler durable-objects:list

# View analytics
npx wrangler pages deployment list
```

## Expected Performance Thresholds

### ✅ **Acceptable Performance (Green Zone)**
- Concurrent connections: 0-800
- Answer submission latency: < 100ms
- Database query time: < 50ms
- Memory usage: < 100MB per room

### ⚠️ **Performance Warning (Yellow Zone)**
- Concurrent connections: 800-1000
- Answer submission latency: 100-300ms
- Database query time: 50-200ms
- Memory usage: 100-120MB per room

### 🚨 **Performance Critical (Red Zone)**
- Concurrent connections: > 1000
- Answer submission latency: > 300ms
- Database query time: > 200ms
- Memory usage: > 120MB per room

## Scaling Strategies if Limits are Reached

1. **Horizontal Scaling**: Split large rooms across multiple Durable Objects
2. **Database Sharding**: Distribute answers across multiple D1 databases
3. **Caching Layer**: Use Cloudflare KV for read-heavy operations
4. **Connection Throttling**: Implement queue system for excess connections

## Real-World Load Test Schedule

```bash
# Week 1: Baseline Testing
artillery run ws-stress-test.yml --count 100

# Week 2: Moderate Load
artillery run ws-stress-test.yml --count 300

# Week 3: High Load
artillery run ws-stress-test.yml --count 500

# Week 4: Extreme Load
artillery run ws-stress-test.yml --count 1000

# Week 5: Burst Testing
artillery run answer-burst-test.yml
```
