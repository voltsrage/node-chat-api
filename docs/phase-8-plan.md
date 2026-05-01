# Phase 8 — Redis Pub/Sub and Socket.io Scaling

## What exists

From Phase 7:
- `src/socket/index.js` — `createSocketServer` wires up Socket.io to the HTTP server; currently uses no adapter
- `src/db/redis.js` — one `ioredis` connection used for all data operations
- `src/index.js` — starts the HTTP server, creates the socket server, starts the eviction job

## What needs to be built

Six steps. The core concept: a Socket.io server holds connected sockets **in memory**. Two instances cannot share memory. Without the Redis adapter, `io.to(roomId).emit(...)` only reaches sockets connected to the **same process**. With the adapter, every emit is published to Redis and every instance receives and forwards it to its locally connected sockets.

---

## Step 1 — Install the adapter

```bash
npm install @socket.io/redis-adapter
```

No other packages needed — `ioredis` is already installed.

---

## Step 2 — Dedicated pub/sub Redis connections

The adapter requires **two separate connections**:

- **`pubClient`** — used to publish events when `io.to(room).emit()` is called on this instance
- **`subClient`** — enters Redis SUBSCRIBE mode and listens for events published by other instances

These must be separate because a Redis connection in SUBSCRIBE mode can only receive messages — it cannot execute any other commands (GET, SET, ZADD, etc.). If you tried to reuse the main `redis` client for subscribing, all data operations would fail while the connection is blocked.

This means each instance maintains **three** Redis connections:
| Connection | Purpose |
|---|---|
| `redis` (from `db/redis.js`) | All data operations: presence, typing, rate limiting, caching |
| `pubClient` | Socket.io adapter — publish events to other instances |
| `subClient` | Socket.io adapter — receive events from other instances (blocked in SUBSCRIBE mode) |

`pubClient.duplicate()` creates a new connection that inherits all the config (URL, retry strategy) from `pubClient`. This is the correct way to create the sub client — no config duplication.

**`src/socket/adapter.js`** — isolated so the connections can be closed cleanly on shutdown:

```js
import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

export const pubClient = new Redis(process.env.REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
});

export const subClient = pubClient.duplicate();

pubClient.on('error', (err) => logger.error({ err }, 'Redis pub client error'));
subClient.on('error', (err) => logger.error({ err }, 'Redis sub client error'));

export async function closeAdapterConnections() {
  await Promise.all([pubClient.quit(), subClient.quit()]);
}
```

---

## Step 3 — Wire the adapter into the socket server

One line added to `createSocketServer` before the `io.use(...)` call. The adapter must be set before any connections are accepted.

**`src/socket/index.js`** — add the adapter:

```js
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './adapter.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  // Must be set before io.use() and io.on('connection') — adapter needs
  // to be in place before any socket events flow through it
  io.adapter(createAdapter(pubClient, subClient));

  io.use(socketAuthenticate);

  io.on('connection', async (socket) => {
    // ... unchanged from Phase 7
  });

  return io;
}
```

---

## Step 4 — Graceful shutdown

Close all three Redis connections (data + pub + sub) and the HTTP server when the process receives SIGTERM.

**`src/index.js`** — update the shutdown handler:

```js
import { closeAdapterConnections } from './socket/adapter.js';
import { redis } from './db/redis.js';

// Replace the existing SIGTERM handler:
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  stopEviction();
  await closeAdapterConnections();
  await redis.quit();
  httpServer.close(() => process.exit(0));
});
```

---

## Step 5 — Local two-instance verification

Install a Socket.io client for the test:

```bash
npm install --save-dev socket.io-client
```

**Start two instances on different ports:**

```bash
# Terminal 1
PORT=3000 node src/index.js

# Terminal 2
PORT=3001 node src/index.js
```

**`scripts/test-scaling.js`** — run this to verify cross-instance delivery:

```js
import { io as ioc } from 'socket.io-client';
import fetch from 'node-fetch'; // or use curl steps below

// ── Setup ──────────────────────────────────────────────────────────────────
// 1. Register two users and get tokens (replace with real tokens from curl)
const TOKEN_A = '<token-for-alice>';
const TOKEN_B = '<token-for-bob>';
const ROOM_ID = '<room-id>';

// Client A connects to instance 1
const clientA = ioc('http://localhost:3000', { auth: { token: TOKEN_A } });

// Client B connects to instance 2
const clientB = ioc('http://localhost:3001', { auth: { token: TOKEN_B } });

clientB.on('message:new', (msg) => {
  console.log('Client B received message:new on instance 2:', msg.content);
  console.assert(msg.content === 'hello from instance 1');
  clientA.disconnect();
  clientB.disconnect();
  process.exit(0);
});

clientA.on('connect', () => {
  console.log('Client A connected to instance 1');
  clientA.emit('message:send', { roomId: ROOM_ID, content: 'hello from instance 1' });
});
```

**What the test proves:**
- Client A is connected to instance 1 (port 3000)
- Client B is connected to instance 2 (port 3001)
- They share no memory
- Client A emits `message:send` → instance 1 saves to MongoDB and publishes to Redis
- Redis pub/sub delivers the event to instance 2
- Instance 2 forwards `message:new` to client B

**Confirm the Redis pub/sub channel is active:**

```bash
redis-cli
> SUBSCRIBE socket.io#/#      # monitor Socket.io adapter channel
# You should see messages flowing when the test runs
```

---

## Step 6 — Nginx sticky sessions (preview for Phase 11)

This is documented here because the **reason** sticky sessions are required is a Socket.io concept, not a deployment detail. Write and understand the config now; it will be dropped into Phase 11's `docker-compose.yml`.

**Why sticky sessions are required:**

The Socket.io handshake is a sequence of HTTP requests that must all reach the same instance:

```
1. GET  /socket.io/?...&transport=polling  → instance A assigns session ID
2. POST /socket.io/?...&transport=polling  → must reach instance A (knows the session)
3. GET  /socket.io/?...&transport=websocket → upgrade; must reach instance A
```

On a round-robin load balancer, request 1 goes to instance A and request 3 goes to instance B. Instance B has no record of the session from step 1. The handshake fails and the client falls back to polling — or fails entirely.

`ip_hash` routes all requests from the same IP to the same upstream, ensuring the entire handshake sequence lands on one instance.

**`nginx/nginx.conf`:**

```nginx
upstream api {
    ip_hash;  # Sticky sessions — required for WebSocket handshake
    server api_1:3000;
    server api_2:3000;
}

server {
    listen 80;

    # WebSocket connections require protocol upgrade headers.
    # Without Upgrade + Connection, Nginx drops the handshake silently
    # and the client falls back to HTTP long-polling.
    location /socket.io/ {
        proxy_pass         http://api;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
    }

    location / {
        proxy_pass       http://api;
        proxy_set_header Host      $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Two headers that must be present for WebSocket to work:**

| Header | Value | Purpose |
|---|---|---|
| `Upgrade` | `$http_upgrade` | Tells the upstream the client wants to upgrade to WebSocket |
| `Connection` | `"upgrade"` | Tells the upstream to treat this as a connection upgrade, not a regular request |

Nginx strips hop-by-hop headers (including `Upgrade` and `Connection`) by default. Without these explicit `proxy_set_header` directives, Nginx forwards a plain HTTP request and the WebSocket handshake silently fails.

---

## Verification summary

| Test | Expected result |
|---|---|
| Run two instances, send from instance 1 | Instance 2 client receives `message:new` |
| `redis-cli SUBSCRIBE socket.io#/#` while sending | Messages appear on the channel |
| Remove `io.adapter(...)` line and re-test | Instance 2 client receives nothing |
| Connect client through Nginx without `ip_hash` | Handshake may fail on round-robin (try to reproduce) |
| Connect client through Nginx with `ip_hash` | Handshake succeeds consistently |

**The "remove adapter" test is the most important one.** Running it proves that cross-instance delivery only works because of the Redis adapter — not because of some other coincidence in the test setup.

---

## File map

| File | Status |
|---|---|
| `src/socket/adapter.js` | New — `pubClient`, `subClient`, `closeAdapterConnections` |
| `src/socket/index.js` | Updated — `io.adapter(createAdapter(pubClient, subClient))` before `io.use()` |
| `src/index.js` | Updated — graceful shutdown closes all three Redis connections |
| `nginx/nginx.conf` | New — `ip_hash` upstream, WebSocket upgrade headers |
| `scripts/test-scaling.js` | New — two-client cross-instance delivery test |

---

## Checklist

- [ ] Step 1 — `@socket.io/redis-adapter` installed
- [ ] Step 2 — `pubClient` and `subClient` are two separate `ioredis` instances; `subClient` created with `pubClient.duplicate()`
- [ ] Step 2 — Both connections have `error` event handlers
- [ ] Step 2 — `closeAdapterConnections` calls `quit()` on both
- [ ] Step 3 — `io.adapter(createAdapter(pubClient, subClient))` called before `io.use()` and `io.on('connection')`
- [ ] Step 4 — SIGTERM handler closes all three Redis connections and the HTTP server
- [ ] Step 5 — Two instances running on ports 3000 and 3001; both connect to same Redis and MongoDB
- [ ] Step 5 — Client on instance 1 sends `message:send`; client on instance 2 receives `message:new`
- [ ] Step 5 — "Remove adapter" test confirms cross-instance delivery breaks without the adapter
- [ ] Step 6 — Nginx config has `ip_hash` in the upstream block
- [ ] Step 6 — `location /socket.io/` sets `proxy_http_version 1.1`, `Upgrade`, and `Connection` headers
- [ ] Step 6 — Can explain why `Connection "upgrade"` is needed (Nginx strips hop-by-hop headers by default)
- [ ] Step 6 — Can explain why round-robin breaks the Socket.io handshake (session ID tied to instance)
- [ ] Knowledge check — Can explain the three Redis connections per instance and why the sub connection cannot be shared
- [ ] Knowledge check — Can explain what happens when `io.to(roomId).emit()` is called with the adapter present
