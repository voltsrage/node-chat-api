# TeamChat API

A production-quality real-time team chat backend built with Node.js, Express, Socket.io, MongoDB, and Redis.

## Features

- **Authentication** — JWT access tokens (15 min) + refresh tokens (7 days) stored in Redis for revocation
- **Rooms** — create, join, leave, and list rooms with Redis caching
- **Real-time Messaging** — send, edit (within 15 min), and soft-delete messages over WebSockets
- **Typing Indicators** — ephemeral Redis TTL-based typing state broadcast to room members
- **Presence** — online/offline tracking per user and per room using Redis sorted sets, with a background eviction job for crashed clients
- **Horizontal Scaling** — Socket.io Redis pub/sub adapter for multi-instance deployments
- **Observability** — structured Pino logging, per-request correlation IDs, Swagger UI

## Architecture

```
HTTP request  → Express (routes → controllers → services → models)
WebSocket     → Socket.io → Redis adapter → other instances
Ephemeral     → Redis (presence, typing, refresh tokens, room cache)
Persistent    → MongoDB (users, rooms, messages)
```

Multi-instance scaling works via two dedicated Redis connections — one for publishing, one for subscribing — wired through `@socket.io/redis-adapter`.

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express 4 |
| WebSockets | Socket.io 4 |
| Database | MongoDB (Mongoose 9) |
| Cache / Pub-Sub | Redis (ioredis 5) |
| Auth | JWT (`jsonwebtoken`), bcrypt |
| Logging | Pino + pino-http |
| Docs | Swagger UI (`swagger-jsdoc`) |

## Project Structure

```
src/
├── index.js                # HTTP server, Socket.io init, graceful shutdown
├── app.js                  # Express middleware chain + routes
├── swagger.js              # OpenAPI spec setup
├── db/
│   ├── connect.js          # MongoDB connection
│   └── redis.js            # Shared Redis client
├── models/                 # Mongoose schemas (User, Room, Message)
├── routes/                 # Express routers (auth, rooms, users)
├── controllers/            # Route handlers — thin layer, delegates to services
├── services/               # Business logic (auth, rooms, messages, presence, users)
├── socket/
│   ├── index.js            # Socket.io server, connection/disconnection lifecycle
│   ├── adapter.js          # Redis pub/sub adapter setup
│   ├── messageHandlers.js  # message:send / edit / delete events
│   └── typingHandlers.js   # typing:start / stop events
├── middleware/
│   ├── authenticate.js     # JWT verification for HTTP routes
│   ├── socketAuthenticate.js # JWT verification for Socket.io handshake
│   ├── correlationId.js    # Per-request UUID tracing
│   └── errorHandler.js     # Global error handler
├── jobs/
│   └── presenceEvictionJob.js # Cleans stale presence entries every 60 s
├── errors/
│   └── AppError.js         # Custom error classes (NotFound, Validation, Conflict, …)
└── utils/
    ├── ApiResponse.js      # Standard { success, statusCode, data, error } envelope
    ├── logger.js           # Pino instance
    ├── tokens.js           # JWT sign/verify + refresh token Redis storage
    └── paginate.js         # Pagination helpers
```

## Architecture Decisions

### Node.js

Chat is an I/O-bound problem, not a CPU-bound one. A server handling thousands of concurrent WebSocket connections spends almost all its time waiting — for database reads, Redis round-trips, and network writes — not computing. Node's single-threaded event loop with non-blocking I/O is purpose-built for this workload: it can hold tens of thousands of idle sockets open with minimal memory overhead, in a way that a thread-per-connection model (Java, .NET defaults) would not scale as cheaply. The same process that serves HTTP requests also manages Socket.io connections, which eliminates cross-process coordination for the common case.

### Express 4

Express is deliberately minimal. It handles routing, middleware chaining, and error propagation — nothing more. The absence of opinions on structure means the architecture here (routes → controllers → services → models) is an explicit choice, not a framework constraint, which makes the layering visible and easy to reason about. The `express-async-errors` package patches the router so async functions forward errors to the global handler without boilerplate try/catch in every controller.

### MongoDB

Chat messages are a natural document store: each message is self-contained, read far more often than written, and the read pattern is always "give me the last N messages in room X ordered by time" — a query that maps directly to a compound index on `{ roomId, createdAt }`. A relational schema would work, but joins between users, rooms, and messages add latency on every page load. The denormalized `senderUsername` field on each message is a deliberate trade-off: it costs a small amount of write-time overhead to keep in sync but eliminates a join on every message fetch, which is the hot path.

Mongoose 9 is used as the ODM for schema validation, index definition, and query building. Schemas are defined with `{ timestamps: true }` to get `createdAt`/`updatedAt` automatically.

### Redis

Redis serves three distinct roles in this system, each chosen for a specific property:

**Ephemeral state (presence, typing):** Sorted sets keyed by `online:users` and `presence:{roomId}` store user IDs scored by Unix timestamp. This makes "who is online?" a single `ZRANGEBYSCORE` call, and stale entries are evicted by a background job using `ZREMRANGEBYSCORE`. Typing indicators use plain TTL keys — they expire automatically after 3 seconds with no cleanup required, which avoids a race condition between "stop typing" and TTL expiry.

**Auth token storage:** Refresh tokens are stored in Redis with a 7-day TTL. This enables true token revocation (logout) without a database write on every request — the access token is verified via JWT signature alone, but the refresh token is checked against Redis on each rotation, so a stolen refresh token can be invalidated instantly.

**Horizontal scaling (pub/sub):** `@socket.io/redis-adapter` uses two dedicated Redis connections (one publisher, one subscriber) to route Socket.io room events between server instances. When Instance A emits to room `general`, Redis fans the event out to Instances B and C, which forward it to their locally connected sockets. This is the standard pattern for scaling Socket.io beyond a single process without introducing a message broker.

### Socket.io

Socket.io sits above the raw WebSocket API and provides rooms (used directly for chat rooms), automatic reconnection with exponential backoff, and a fallback to HTTP long-polling for environments where WebSockets are blocked. The built-in room abstraction means `io.to(roomId).emit(...)` handles fan-out to all members — no manual connection tracking needed. Authentication is enforced at the handshake layer via a middleware that validates the JWT before the connection is established, so unauthenticated sockets are rejected before they can consume resources.

### JWT with Refresh Token Rotation

Access tokens are short-lived (15 minutes) and verified purely by signature — no database lookup per request. This keeps the hot path (authenticated API calls) fast. Refresh tokens are long-lived (7 days) but stored in Redis, so they can be revoked. On each refresh, the old token is deleted and a new one is issued (rotation), which limits the window of exposure if a refresh token is intercepted. This is the standard stateless-auth-with-revocation pattern — stateless for scale, revocable for security.

bcrypt with 12 rounds is used for password hashing. 12 rounds is the current industry default that balances security (slow enough to resist brute force) with latency (fast enough to not noticeably delay login).

### Cursor-based Pagination

Message history uses an ISO 8601 timestamp as the cursor (`before` query param) rather than offset/limit. Offset pagination on a high-write collection produces inconsistent results — if 10 messages are added while a user is paginating, offset 50 skips or duplicates messages. Cursor pagination is stable because the cursor anchors to a specific point in time, which is monotonically ordered by the `createdAt` index.

### Pino for Logging

Pino is the fastest Node.js logger by a significant margin (roughly 5–10x faster than Winston in benchmarks) because it writes structured JSON synchronously to stdout and defers formatting to a separate process (`pino-pretty` in development). Structured JSON logs are consumed directly by log aggregation systems (Datadog, Loki, CloudWatch) without parsing. Per-request correlation IDs are injected by middleware and attached to child loggers, so every log line for a given request carries the same `correlationId` — essential for tracing failures across a distributed system.

### ES Modules (`"type": "module"`)

The project uses native ES module syntax (`import`/`export`) rather than CommonJS (`require`). This is the current Node.js standard, avoids the dual-module hazard when mixing ESM and CJS packages, and aligns with how browser and edge runtimes work. All tooling (Node 18+, Mongoose 9, ioredis 5, Socket.io 4) supports ESM natively.

---

## Getting Started

### Prerequisites

- Node.js 18+
- MongoDB 6+
- Redis 7+

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
MONGO_URI=mongodb://localhost:27017/team-chat
NODE_ENV=development
LOG_LEVEL=info
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=another-secret-change-me-in-production
REDIS_URL=redis://localhost:6379
```

### Seed (optional)

```bash
node src/seed/seed.js
```

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

API docs available at `http://localhost:3000/swagger` (development only).

## API Reference

All REST endpoints are prefixed `/api/v1`. Authenticated routes require:

```
Authorization: Bearer <access_token>
```

Responses follow a standard envelope:

```json
{ "success": true, "statusCode": 200, "data": {}, "error": null }
```

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Register user, returns tokens |
| POST | `/auth/login` | — | Login, returns tokens |
| POST | `/auth/refresh` | — | Exchange refresh token for new access token |
| POST | `/auth/logout` | ✓ | Revoke refresh token |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users/me` | ✓ | Get own profile (includes email) |
| PATCH | `/users/me` | ✓ | Update `displayName` / `avatarUrl` |
| GET | `/users/:id` | ✓ | Get public profile of another user |

### Rooms

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/rooms` | ✓ | Create room (creator auto-joins) |
| GET | `/rooms` | ✓ | List rooms (paginated) |
| GET | `/rooms/:id` | ✓ | Get room details (cached 5 min) |
| POST | `/rooms/:id/join` | ✓ | Join a room |
| POST | `/rooms/:id/leave` | ✓ | Leave a room |
| GET | `/rooms/:id/members` | ✓ | List room members (paginated) |
| GET | `/rooms/:id/messages` | ✓ | Message history (cursor pagination) |
| GET | `/rooms/:id/presence` | ✓ | Active users in room |

### Message History Query Params

| Param | Default | Max | Description |
|---|---|---|---|
| `before` | now | — | ISO timestamp cursor |
| `limit` | 50 | 100 | Messages per page |

## WebSocket Events

Connect with:

```js
const socket = io("http://localhost:3000", {
  auth: { token: "<access_token>" }
});
```

On connection the server auto-joins the socket to all rooms the user is a member of.

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `message:send` | `{ roomId, content }` | Send a message |
| `message:edit` | `{ messageId, content }` | Edit own message (within 15 min) |
| `message:delete` | `{ messageId }` | Soft-delete own message |
| `typing:start` | `{ roomId }` | Broadcast typing indicator |
| `typing:stop` | `{ roomId }` | Stop typing indicator |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `message:new` | message object | New message in a joined room |
| `message:edited` | updated message | Message was edited |
| `message:deleted` | `{ messageId, roomId }` | Message was soft-deleted |
| `typing:update` | `{ roomId, userId, isTyping }` | Typing state changed |
| `error` | `{ message, code }` | Handler error |

## Data Models

### User

```
username    String  unique, required
email       String  unique, required (lowercase)
passwordHash String  required, never returned in responses
displayName String  nullable
avatarUrl   String  nullable
createdAt / updatedAt
```

### Room

```
name        String  unique, required
description String  nullable
createdBy   ObjectId → User
memberIds   [ObjectId → User]
createdAt / updatedAt
```

Indexes: `name` (unique), `memberIds`, `createdAt desc`

### Message

```
roomId          ObjectId → Room
senderId        ObjectId → User
senderUsername  String  (denormalized)
content         String
type            enum: text | system
editedAt        Date  nullable
deletedAt       Date  nullable  (soft delete)
createdAt / updatedAt
```

Indexes: `{ roomId, createdAt desc }` (compound), `senderId`

## Presence System

Presence is tracked entirely in Redis using sorted sets. Scores are Unix timestamps.

| Key | Value | Meaning |
|---|---|---|
| `online:users` | `userId → timestamp` | Global online set |
| `presence:{roomId}` | `userId → timestamp` | Per-room active users |
| `typing:{roomId}:{userId}` | TTL key | User is typing in room |

A background job runs every 60 seconds to evict entries older than 5 minutes, handling clients that disconnected without sending a proper close frame.

Multi-tab support: a user is only marked offline when their *last* socket disconnects.

## Scaling

To run multiple instances, point all of them at the same Redis and MongoDB. The Redis pub/sub adapter routes Socket.io events between instances transparently.

```
Instance A ──┐              ┌── Instance B
             └── Redis ──── ┘
                  │
             MongoDB (shared)
```

## Implemented Phases

| Phase | Feature |
|---|---|
| 1 | MongoDB schemas and indexes |
| 2 | Express setup, error handling, Swagger |
| 3 | JWT authentication + refresh tokens |
| 4 | Room CRUD with Redis caching |
| 5 | Message history with cursor pagination |
| 6 | Real-time messaging and typing indicators |
| 7 | Presence system with Redis sorted sets |
| 8 | Redis pub/sub adapter for horizontal scaling |

## Roadmap

| Phase | Feature |
|---|---|
| 9 | Rate limiting |
| 10 | Health checks |
| 11 | Docker Compose and deployment |
| 12 | CI/CD pipeline |
| 14 | Email verification |
| 15 | Password reset and account lockout |
| 16 | Async job queue (BullMQ) |
