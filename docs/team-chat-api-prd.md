# PRD: Team Chat API

## Overview

A real-time team chat backend built with Node.js, Express, Mongoose, Socket.io, and Redis. Every technology choice is deliberate — each one solves a problem that the others cannot. The project is designed to cover the concepts that the Fleet Telemetry API does not: document database design, WebSocket communication, real-time presence, and Redis as more than a cache.

---

## Goals

- Internalize how MongoDB and a relational database think about data differently
- Understand why Socket.io needs Redis when running on more than one instance
- Practice the Node.js runtime model (event loop, async patterns) as distinct from .NET's threading model
- Build JWT auth with revocable refresh tokens — a production-realistic auth pattern
- Produce a second deployable project that demonstrates breadth across two different stacks

## Non-Goals

- Frontend UI
- File uploads or media messages
- End-to-end encryption
- Full OAuth integration

---

## API Conventions

Same envelope as the Fleet Telemetry API — consistency across projects is intentional.

**Success:**
```json
{
  "success": true,
  "statusCode": 200,
  "data": { },
  "error": null
}
```

**Error:**
```json
{
  "success": false,
  "statusCode": 404,
  "data": null,
  "error": {
    "message": "Room not found.",
    "code": "ROOM_NOT_FOUND"
  }
}
```

### Pagination

Message history uses **cursor-based pagination**, not offset. Offset pagination breaks for real-time data: if a new message arrives between page 1 and page 2 requests, every message shifts by one and the caller sees a duplicate on page 2.

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "items": [ ],
    "nextCursor": "2026-04-22T10:15:00.000Z",
    "hasMore": true
  },
  "error": null
}
```

Callers pass `?before={cursor}&limit=50`. The cursor is the `createdAt` timestamp of the oldest message in the current page.

All other list endpoints (rooms, members) use standard offset pagination: `?page=1&pageSize=20`.

---

## Domain Model

A **user** has an account, authenticates via JWT, and can join multiple rooms.

A **room** is a named channel. Any user can create one. Members receive all messages sent to the room in real time.

A **message** is sent by a user to a room. It is stored in MongoDB for history and broadcast via Socket.io for real-time delivery.

**Presence** is tracked in Redis — whether a user is currently connected and which rooms they are active in.

---

## Features

### 1. Authentication

**Description:** Users register, log in, and receive a short-lived JWT for API calls and Socket.io connections. A long-lived refresh token stored in Redis enables token renewal without re-login. Refresh tokens can be revoked (logout), which solves the primary weakness of stateless JWTs.

**Endpoints:**
- `POST /api/v1/auth/register` — create account, returns access token + refresh token
- `POST /api/v1/auth/login` — authenticate, returns access token + refresh token
- `POST /api/v1/auth/refresh` — exchange refresh token for a new access token
- `POST /api/v1/auth/logout` — revoke the refresh token in Redis

**Redis keys:**
```
refresh:{userId}:{tokenId}   STRING   value = "valid"   TTL = 7 days
```

**Auth flow for Socket.io:** The client sends the JWT in the handshake `auth` object. A Socket.io middleware validates the token before the connection is accepted. An expired or missing token disconnects the socket immediately.

**Concepts practiced:** JWT structure and claims, access vs refresh token pattern, token revocation via Redis, stateless vs stateful auth trade-offs.

---

### 2. User Management

**Description:** Basic profile management after registration.

**Endpoints:**
- `GET /api/v1/users/me` — get own profile
- `PUT /api/v1/users/me` — update display name or avatar URL
- `GET /api/v1/users/:id` — get another user's public profile

**Concepts practiced:** Authentication middleware applied to protected routes, partial updates, Mongoose validation.

---

### 3. Room Management

**Description:** Create, join, and leave rooms. Room membership controls which Socket.io rooms a user is subscribed to.

**Endpoints:**
- `POST /api/v1/rooms` — create a room
- `GET /api/v1/rooms` — list all rooms (paginated)
- `GET /api/v1/rooms/:id` — get room details
- `POST /api/v1/rooms/:id/join` — join a room; subscribe socket to the room channel
- `POST /api/v1/rooms/:id/leave` — leave a room; unsubscribe socket
- `GET /api/v1/rooms/:id/members` — list current members (paginated)

**Caching:** Room details are cached in Redis for 5 minutes. Cache is invalidated when a member joins or leaves.

**Concepts practiced:** REST resource design, Redis cache invalidation, the relationship between HTTP state (membership in MongoDB) and real-time state (socket room subscription).

---

### 4. Real-time Messaging

**Description:** Messages are sent and received over Socket.io. The REST endpoint provides historical message retrieval. Both are needed — Socket.io delivers messages in real time; the REST endpoint rebuilds history when a user opens a room they were away from.

**Socket.io events:**
- `message:send` (client → server) — send a message to a room
- `message:new` (server → client) — broadcast a new message to all room members
- `message:edit` (client → server) — edit own message (within 15 minutes)
- `message:delete` (client → server) — soft-delete own message
- `typing:start` / `typing:stop` (client → server) — typing indicator
- `typing:update` (server → client) — broadcast who is typing to the room

**REST endpoint:**
- `GET /api/v1/rooms/:id/messages?before={cursor}&limit={n}` — paginated message history

**Typing indicators:** Stored as Redis keys with a 3-second TTL. When the TTL expires, the typing state clears automatically — no manual cleanup needed.

```
typing:{roomId}:{userId}   STRING   value = username   TTL = 3s
```

**Concepts practiced:** Socket.io rooms and event broadcasting, cursor pagination for time-series data, Redis TTL as a self-cleaning mechanism, the difference between persisted state (MongoDB) and ephemeral state (Redis).

---

### 5. Presence System

**Description:** Track which users are currently online and which rooms they are active in. Presence state lives entirely in Redis — it is ephemeral and does not belong in MongoDB.

**Redis data structures:**
```
online:users              ZSET   member = userId   score = lastActiveTimestamp
presence:{roomId}         ZSET   member = userId   score = joinedTimestamp
```

**Behavior:**
- When a socket connects: add user to `online:users` with current timestamp as score
- When a socket joins a room: add user to `presence:{roomId}`
- When a socket disconnects: remove from `online:users` and all `presence:{roomId}` keys
- A background job runs every 60 seconds to evict entries from `online:users` where score is older than 5 minutes (handles crashed clients that did not disconnect cleanly)

**Endpoint:**
- `GET /api/v1/rooms/:id/presence` — list users currently online in the room

**Concepts practiced:** Redis sorted sets, using timestamps as scores for range queries, handling unclean disconnects, ephemeral vs persistent data.

---

### 6. Scaling Socket.io with Redis Pub/Sub

**Description:** A single Socket.io server holds its connected sockets in memory. If two users are connected to different server instances, a message sent by user A cannot reach user B — their sockets are on different processes.

The Redis adapter solves this: when a message is emitted to a room, it is published to a Redis channel. Every server instance subscribes to that channel and forwards the message to its locally connected sockets.

**Implementation:** `@socket.io/redis-adapter` using `ioredis`. Two Redis connections are required per instance — one for publishing, one for subscribing.

**Container layout:**
```
Internet
  └── Nginx (upstream: api_1, api_2)
        ├── API instance 1 (Socket.io + Express)  ─┐
        └── API instance 2 (Socket.io + Express)  ─┴── Redis (pub/sub + data)
                                                        └── MongoDB
```

**Sticky sessions note:** Nginx must be configured to route a client's WebSocket upgrade request to the same instance as their initial HTTP handshake. Without sticky sessions, the Socket.io handshake will fail on a round-robin load balancer. Configure `ip_hash` in Nginx for this project.

**Concepts practiced:** Horizontal scaling of stateful connections, Redis pub/sub, why WebSockets require special load balancer configuration, the difference between Redis as a cache (key/value store) and Redis as a message broker (pub/sub).

---

### 7. Rate Limiting

**Description:** Prevent message flooding per user and brute-force attempts on auth endpoints. Implemented with a Redis sliding window counter.

**Rules:**
- Messages: 30 per user per 60 seconds — enforced in Socket.io middleware
- Auth endpoints: 10 attempts per IP per 15 minutes — enforced in Express middleware

**Redis keys:**
```
ratelimit:msg:{userId}     STRING   value = count   TTL = 60s
ratelimit:auth:{ip}        STRING   value = count   TTL = 900s
```

**Response on breach:** Socket.io emits an `error` event to the client. The REST auth endpoint returns `429 Too Many Requests`.

**Concepts practiced:** Redis INCR + EXPIRE as a rate limit primitive, sliding window vs fixed window trade-offs, enforcing limits at the WebSocket layer vs the HTTP layer.

---

### 8. Health Checks

**Endpoints:**
- `GET /health` — liveness: returns `200` if the process is running
- `GET /health/ready` — readiness: checks MongoDB and Redis connectivity; returns `503` if either fails

**Response shape** (outside the standard envelope):
```json
{
  "status": "healthy",
  "checks": {
    "mongodb": "healthy",
    "redis": "healthy"
  }
}
```

---

## MongoDB Schema & Indexing Plan

```javascript
// User
{
  _id:          ObjectId,
  username:     String,    // unique, required
  email:        String,    // unique, required
  passwordHash: String,    // required — never return this field
  displayName:  String,    // nullable
  avatarUrl:    String,    // nullable
  createdAt:    Date
}
indexes:
  { username: 1 }   unique
  { email: 1 }      unique

// Room
{
  _id:         ObjectId,
  name:        String,    // unique, required
  description: String,    // nullable
  createdBy:   ObjectId,  // ref: User
  memberIds:   [ObjectId], // ref: User — array for small rooms (< 500 members)
  createdAt:   Date
}
indexes:
  { name: 1 }            unique
  { memberIds: 1 }       for "which rooms does this user belong to?"
  { createdAt: -1 }      for sorted room listing

// Message
{
  _id:             ObjectId,
  roomId:          ObjectId,  // ref: Room
  senderId:        ObjectId,  // ref: User
  senderUsername:  String,    // denormalized — avoids populate on every message read
  content:         String,
  type:            String,    // enum: "text" | "system"
  editedAt:        Date,      // nullable
  deletedAt:       Date,      // nullable — soft delete
  createdAt:       Date
}
indexes:
  { roomId: 1, createdAt: -1 }   compound — primary query pattern
  { senderId: 1 }                for "messages by this user"
```

**Schema design notes:**

`memberIds` as an array on Room works well for rooms with a few hundred members. If a room could have thousands, a separate `RoomMembership` collection with `{ roomId, userId, joinedAt }` and indexes on both fields is the correct design. This project uses the array approach and treats the scale limit as a known, documented trade-off.

`senderUsername` is deliberately denormalized onto Message. The alternative — populating `senderId` on every message read — adds a round-trip per query. Since a username rarely changes and the message volume is high, the denormalization is the right call. If a username does change, a migration job updates affected messages.

---

## Design Decisions

### Document vs Relational Data Modeling

MongoDB does not enforce foreign keys. Relationships are modeled either by **embedding** (subdocument inside the parent) or **referencing** (storing an ObjectId and querying separately). The key question for each relationship is: "Are these always read together?"

| Relationship | Approach | Reason |
|---|---|---|
| Room → members | Reference (array of ObjectIds) | Members change frequently; embedding would rewrite the room document on every join/leave |
| Message → sender | Reference (ObjectId) + denormalized username | Messages are read in bulk; full populate on every read is expensive |
| Message → room | Reference (ObjectId) | Messages are queried by roomId; embedding all messages in the room document would produce an unbounded document |

### Cursor Pagination vs Offset Pagination

Offset pagination (`SKIP n`) in MongoDB is expensive on large collections — the database must scan and discard the first `n` documents. Cursor pagination uses an indexed field (`createdAt`) as a bookmark: `WHERE createdAt < cursor ORDER BY createdAt DESC LIMIT n`. This is always an index seek regardless of how deep into the history you are.

Additionally, offset pagination produces duplicates in real-time data: new messages shift the offset between requests. Cursor pagination is immune to this because it anchors on a specific point in time.

### JWT + Refresh Token Pattern

Access tokens are short-lived (15 minutes) and stateless — the server validates the signature without a database lookup. Refresh tokens are long-lived (7 days) and stored in Redis — this makes them revocable. Logout deletes the Redis key; the next refresh attempt fails.

The trade-off: the access token cannot be revoked during its 15-minute window. If a token is stolen, the attacker has up to 15 minutes of access. For a chat application, this is acceptable. For banking, it would not be.

### Redis Data Structures by Use Case

| Use case | Data structure | Why |
|---|---|---|
| Refresh token storage | STRING with TTL | Simple key-value lookup; TTL handles expiry automatically |
| Online users | ZSET (score = timestamp) | Range query: "who has been active in the last 5 minutes?" |
| Room presence | ZSET (score = join time) | Ordered by join time; ZCARD gives member count in O(1) |
| Typing indicators | STRING with TTL | Auto-expires after 3 seconds — no cleanup code needed |
| Rate limiting | STRING with INCR + TTL | Atomic increment; TTL resets the window |
| Room cache | STRING (JSON) | Simple get/set with expiry |
| Socket.io scaling | Pub/Sub channels | Broadcast across instances; not a storage concern |

### Mongoose vs Raw MongoDB Driver

Mongoose adds schema validation, virtual fields, middleware hooks (`pre('save')`, `post('find')`), and a cleaner query API. The cost is a small overhead on every operation and some magic that can surprise you (implicit `__v` version key, query middleware that does not fire on `updateMany`). For this project, Mongoose is the right choice — the validation and hook system are concepts worth practicing. Raw driver usage is worth knowing as a contrast.

### Pino for Logging

Pino is used over Winston because it is significantly faster (lower overhead per log call) and outputs newline-delimited JSON natively, which Seq can ingest directly. Configure a Pino transport that POSTs to Seq's ingestion endpoint.

---

## Non-Functional Requirements

| Concern | Target |
|---|---|
| Auth | JWT (15 min access token) + Redis refresh token (7 days) |
| Logging | Pino → Seq; structured properties (`userId`, `roomId`, `socketId`); correlation ID per HTTP request and per socket connection |
| API docs | Swagger/OpenAPI at `/swagger` in development |
| Health checks | `GET /health` (liveness), `GET /health/ready` (MongoDB + Redis) |
| Rate limiting | Redis sliding window; 30 messages/user/min; 10 auth attempts/IP/15 min |
| Testing | Jest; unit tests for auth logic and rate limiter; integration tests for message persistence and cursor pagination |
| Resilience | Mongoose auto-reconnect; Redis connection retry with exponential backoff; Socket.io client reconnect handled by the client library |
| Config | All secrets via environment variables; never committed |
| CI/CD | GitLab CI pipeline: lint → test → build → deploy |

---

## Build Order

| Phase | Feature | Concepts |
|---|---|---|
| 1 | MongoDB schemas + indexes + Mongoose models | Document design, embedding vs referencing, index strategy |
| 2 | Express setup + middleware + error handling + Swagger | Middleware chain, error propagation, OpenAPI |
| 3 | Auth (register, login, JWT, refresh tokens in Redis) | JWT, stateless vs stateful, Redis STRING + TTL |
| 4 | Room CRUD + Redis caching | Cache invalidation, REST design |
| 5 | Message history REST (cursor pagination) | Cursor vs offset pagination, compound index usage |
| 6 | Socket.io real-time messaging + typing indicators | WebSocket events, Redis TTL auto-expiry |
| 7 | Presence system (Redis sorted sets) | ZSET operations, unclean disconnect handling |
| 8 | Redis pub/sub + Socket.io Redis adapter | Horizontal scaling, pub/sub pattern |
| 9 | Rate limiting (Redis sliding window) | INCR + EXPIRE, 429 handling |
| 10 | Health checks | Liveness vs readiness |
| 11 | Docker Compose + Nginx + GCP VM deployment | Container networking, sticky sessions, Socket.io upgrade |
| 12 | GitLab CI/CD pipeline | lint → test → build → deploy |
| 13 | Git hygiene | Merge requests, linear history |
| 14 | Email verification | Redis token storage, email delivery, account activation gate |
| 15 | Password reset + account lockout | Time-limited reset tokens, failed-attempt counters, Redis TTL |
| 16 | Async job queue (BullMQ) | Job queues, worker processes, retry strategies, dead-letter queues |
| 17 | Message reactions | Subdocument maps, atomic `$set`/`$pull`, Socket.io broadcast |
| 18 | Unread message counts | Redis INCR per user per room, reset on read |
| 19 | Private rooms + invitations | Role-gated access, invite tokens in Redis, 403 enforcement |
| 20 | Direct messages | Find-or-create pattern, idempotent DM room creation |
| 21 | Room roles / RBAC | Multi-role membership schema, permission middleware, migration |
| 22 | Full-text message search | MongoDB text index, `$text` operator, relevance scoring |
| 23 | Read receipts | Redis STRING per user per room, updated on history fetch |
| 24 | Prometheus metrics | `prom-client`, four golden signals, Grafana scrape config |

---

## Step-by-Step Guide

---

### Phase 1 — MongoDB Schemas and Indexes

**What to do:**
1. Before writing any code, sketch the three collections on paper. For each relationship, decide: embed or reference? Use the rule: if you always read them together and the nested data is bounded in size, embed. Otherwise, reference.
2. Define Mongoose schemas for User, Room, and Message. Add Mongoose validators for required fields and enum constraints.
3. Add indexes explicitly — do not rely on Mongoose's automatic `_id` index alone. Identify which fields will appear in `find()` filters and `sort()` clauses, and index them.
4. Seed the database with two rooms, five users, and at least 100 messages across both rooms to have realistic data for testing queries.
5. Open the MongoDB shell (`mongosh`) and run `.explain("executionStats")` on the message query you plan to use for history retrieval. Confirm it uses the compound index, not a collection scan.

**Why:**
MongoDB query performance is entirely dependent on your index strategy. A missing index on `roomId` means every message query scans the entire collection. `.explain()` is the MongoDB equivalent of `EXPLAIN ANALYZE` in PostgreSQL — it shows whether an index is being used and how many documents were examined. Getting comfortable with it in Phase 1 builds a habit of verifying, not assuming.

---

### Phase 2 — Express Setup, Middleware, and Swagger

**What to do:**
1. Set up Express with a clear middleware order: request logging first, then body parsing, then correlation ID assignment, then routes, then error handling last.
2. Write a global error handler middleware that catches all unhandled errors and returns the standard response envelope. In Express, error handlers take four arguments `(err, req, res, next)` — the four-argument signature is how Express knows it is an error handler.
3. Enable Swagger/OpenAPI from the start and document endpoints as you build them.
4. Implement the correlation ID middleware: generate a UUID per request, attach it to `req`, and include it in every log line for that request using Pino's child logger.

**Why:**
In Express, middleware order is the application's execution model. The error handler being last is not a convention — it is the mechanism. Understanding why it must be last, and what happens if it is not, is the difference between accidentally swallowing errors and surfacing them correctly.

---

### Phase 3 — Authentication

**What to do:**
1. Implement registration with password hashing (bcrypt, cost factor 12). Never store plaintext passwords. Never return the `passwordHash` field in any response.
2. Implement login. Issue a short-lived access JWT (15 minutes, signed with a secret from environment config) and a long-lived refresh token (a random UUID stored in Redis with a 7-day TTL).
3. Write the JWT verification middleware. Attach the decoded user payload to `req.user`. Return `401` for missing, expired, or invalid tokens.
4. Implement the refresh endpoint: validate the refresh token exists in Redis, issue a new access token, and optionally rotate the refresh token.
5. Implement logout: delete the refresh token from Redis. The access token remains valid until it expires — that is the trade-off of stateless tokens.
6. Write the Socket.io authentication middleware: validate the JWT from the socket handshake `auth` object before accepting the connection.

**Why:**
The difference between access tokens and refresh tokens maps directly to the stateless vs stateful tension in system design. The access token is fast (no Redis lookup) but unrevocable. The refresh token is revocable (Redis delete) but requires a round-trip. Implementing both makes the trade-off concrete rather than theoretical.

---

### Phase 4 — Room Management and Redis Caching

**What to do:**
1. Build the room CRUD endpoints. Use the JWT middleware to protect all routes.
2. Add Redis caching to `GET /api/v1/rooms/:id`: cache the room document as JSON with a 5-minute TTL. On join/leave, delete the cache entry so the next read fetches fresh data.
3. Observe the cache invalidation problem: if you cache the member list inside the room document and a user joins, the cached member count is wrong until TTL expires. Decide whether to invalidate immediately or accept stale data, and document the choice.
4. When a user joins a room via the REST endpoint and has an active socket connection, also add their socket to the Socket.io room channel so they receive subsequent messages in real time.

**Why:**
Cache invalidation is consistently cited as one of the two hard problems in computer science. This phase makes it tangible: the member count is wrong for up to 5 minutes after a join unless you invalidate proactively. The decision of when to invalidate — and what the window of staleness costs — is a system design question.

---

### Phase 5 — Message History and Cursor Pagination

**What to do:**
1. Build `GET /api/v1/rooms/:id/messages?before={cursor}&limit=50`. The query is: `Message.find({ roomId, createdAt: { $lt: cursor } }).sort({ createdAt: -1 }).limit(n)`.
2. Run `.explain("executionStats")` on this query. Confirm it uses the `{ roomId: 1, createdAt: -1 }` compound index. Check `totalDocsExamined` — it should equal the number of documents returned, not the total collection size.
3. Test pagination correctness: send 10 messages, fetch page 1 (5 messages), send another message, fetch page 2. Confirm no duplicates appear and no messages are skipped.
4. Do the same test with offset pagination and observe the duplication. This is why cursor pagination exists for real-time data.

**Why:**
Cursor pagination is harder to implement than offset pagination but essential for any feed where data is being written concurrently with reads. The `.explain()` check confirms the index is carrying the query load — not intuition.

---

### Phase 6 — Socket.io Real-time Messaging and Typing Indicators

**What to do:**
1. Handle the `message:send` event: validate the content, save to MongoDB, broadcast to the room with `io.to(roomId).emit('message:new', message)`.
2. Handle `typing:start`: set `typing:{roomId}:{userId}` in Redis with a 3-second TTL and broadcast `typing:update` to the room. Do not handle `typing:stop` with a Redis delete — let the TTL expire. Verify this: send `typing:start` but never `typing:stop`; confirm the typing indicator disappears after 3 seconds.
3. Handle disconnection (`socket.on('disconnect')`): remove the user from all presence keys, broadcast their departure to all rooms they were in.
4. Test message delivery across two separate browser tabs. Confirm both receive the message in real time.

**Why:**
The typing indicator TTL pattern is a real production technique — letting Redis expiry handle cleanup avoids race conditions where `typing:stop` arrives before `typing:start` is processed. The disconnect handler is where all the cleanup of ephemeral state happens: if it is incomplete, users appear online indefinitely.

---

### Phase 7 — Presence System

**What to do:**
1. On socket connect: `ZADD online:users {timestamp} {userId}` and `ZADD presence:{roomId} {timestamp} {userId}` for each room the user is in.
2. On socket disconnect: `ZREM online:users {userId}` and `ZREM presence:{roomId} {userId}` for all rooms.
3. Build a background job that runs every 60 seconds: `ZREMRANGEBYSCORE online:users -inf {fiveMinutesAgo}` to evict users whose last-active score is older than 5 minutes. This handles clients that crash without disconnecting.
4. Implement `GET /api/v1/rooms/:id/presence` using `ZRANGE presence:{roomId} 0 -1` to return all currently active members.
5. Test the crash case: kill the client process without closing the socket. Confirm the background job removes the user after 5 minutes.

**Why:**
Presence is one of the hardest problems in distributed systems because processes die without notice. The sorted set + background eviction pattern is how real-time presence is handled at scale. The score (timestamp) is the key insight — it turns the sorted set into a time-based index that lets you efficiently find stale entries.

---

### Phase 8 — Redis Pub/Sub and Socket.io Scaling

**What to do:**
1. Add `@socket.io/redis-adapter` to the Socket.io server. Pass two `ioredis` connections — one for pub, one for sub.
2. Run two instances of the API locally using different ports. Connect two clients, one to each instance, and join the same room.
3. Send a message from client 1's instance. Confirm client 2 receives it even though they are on different instances.
4. Update the `docker-compose.yml` to run two API replicas (`deploy: replicas: 2`).
5. Configure Nginx `ip_hash` for sticky sessions. Test that the Socket.io handshake completes correctly under Nginx.
6. Understand the two Redis connection requirement: the subscribing connection blocks waiting for messages and cannot be used for other commands; the publishing connection is used for all other Redis operations.

**Why:**
This phase is where the entire value of Redis pub/sub becomes clear. Without it, Socket.io only works on a single instance — horizontal scaling breaks real-time delivery. The two-connection requirement is a non-obvious implementation detail that trips up many developers the first time. Understanding it means you can explain the architecture — not just use the library.

---

### Phase 9 — Rate Limiting

**What to do:**
1. Implement the message rate limiter in Socket.io middleware using Redis INCR: on first call, set the key with `INCR` and then `EXPIRE 60`. On subsequent calls within the window, just `INCR`. Emit an error event if the count exceeds the limit.
2. Implement the auth rate limiter in Express middleware using the same pattern.
3. Test the rate limiter: send 31 messages rapidly from one client; confirm the 31st is rejected. Confirm that a second client is not affected.
4. Think through the race condition in the naive INCR + EXPIRE approach: if the process dies between INCR and EXPIRE, the key never expires and the user is permanently rate-limited. Understand why `SET key 1 EX 60 NX` (set-if-not-exists with TTL) is atomic and avoids this.

**Why:**
Rate limiting with Redis is a standard pattern because Redis operations are single-threaded — INCR is atomic, so there are no race conditions on the counter itself. The INCR + EXPIRE race condition is a subtle gotcha that interviewers use to probe whether you understand atomic operations.

---

### Phase 10 — Health Checks

**What to do:**
1. `GET /health`: return `200` immediately. No checks.
2. `GET /health/ready`: attempt a `mongoose.connection.db.admin().ping()` and a `redis.ping()`. Return `200` if both succeed, `503` with details if either fails.
3. Configure the Docker `HEALTHCHECK` to call `GET /health`.
4. Test: stop the MongoDB container; confirm `GET /health/ready` returns `503`; confirm `GET /health` still returns `200`.

---

### Phase 11 — Docker Compose, Nginx, and GCP VM Deployment

**What to do:**
1. Write a `Dockerfile` for the API. Use a multi-stage build: install dependencies in one stage, copy only production files to the final stage to keep the image small.
2. Write a `docker-compose.yml` with five services: `api`, `mongo`, `redis`, `nginx`, `seq`. Define an internal network — `mongo` and `redis` must not be reachable from outside the VM.
3. Configure Nginx with `ip_hash` for sticky sessions and `proxy_pass` to the API. Add the WebSocket upgrade headers (`Upgrade` and `Connection`) — without them, the WebSocket handshake fails at the proxy.
4. Add Nginx rate limiting on the auth endpoints as a second layer of defense.
5. Deploy to the GCP Compute Engine VM following the same process as the Fleet Telemetry API.

**Nginx WebSocket headers (required):**
```nginx
location /socket.io/ {
    proxy_pass         http://api;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
}
```

**Why:**
WebSocket connections require a protocol upgrade from HTTP/1.1. A proxy that does not forward the `Upgrade` header will silently drop the WebSocket handshake — the client will fall back to HTTP long-polling, which works but is inefficient and easy to miss. Understanding why those two headers are required is the kind of operational knowledge that separates someone who has deployed a WebSocket application from someone who has only built one locally.

---

### Phase 12 — GitLab CI/CD Pipeline

**What to do:**
1. Create `.gitlab-ci.yml` with four stages: `lint`, `test`, `build`, `deploy`.
2. **Lint:** run ESLint. Fail the pipeline on any error.
3. **Test:** run Jest. Fail the pipeline if any test fails or coverage drops below the threshold.
4. **Build:** build the Docker image and push it to a container registry.
5. **Deploy:** SSH into the VM, pull the new image, and run `docker compose up -d`. Runs only on merges to `main`.
6. Store all SSH keys, registry credentials, and environment variables as GitLab CI/CD masked variables.

---

### Phase 13 — Git Hygiene

**What to do:**
Same process as the Fleet Telemetry API. One branch per feature, descriptive merge request descriptions, rebase before merge. The only addition: because Socket.io events are not part of the OpenAPI spec, document them in a separate `SOCKET_EVENTS.md` file at the repository root.

---

### Phase 14 — Email Verification

**What to do:**
1. Add a `verified` boolean field (default `false`) and `verificationToken` field to the User schema.
2. On registration, generate a cryptographically random token (`crypto.randomBytes(32).toString('hex')`), store it in Redis with a 24-hour TTL under key `email-verify:{token}` → `userId`, and send a verification email containing a link with the token.
3. Build `GET /api/v1/auth/verify-email?token=<token>`: look up the token in Redis, set `verified: true` on the user, delete the Redis key.
4. Gate protected actions (sending messages, creating rooms) behind a `requireVerified` middleware that checks `req.user.verified` and returns `403 UNVERIFIED` if not set.
5. Add `POST /api/v1/auth/resend-verification`: rate-limit this endpoint (max 3 per hour per user) to prevent abuse.

**Why:**
Email verification is the first line of defence against throwaway accounts. The Redis-backed token pattern — rather than storing the token in MongoDB — is worth understanding: it gives you automatic expiry, atomic lookup-and-delete, and no need for a cron job to clean up expired tokens. The `requireVerified` middleware is a good exercise in layering authorization checks without duplicating them.

---

### Phase 15 — Password Reset and Account Lockout

**What to do:**
1. Build `POST /api/v1/auth/forgot-password`: generate a reset token, store it in Redis under `pwd-reset:{token}` → `userId` with a 1-hour TTL, and send a reset email.
2. Build `POST /api/v1/auth/reset-password`: validate the token, hash the new password, update the user, delete the Redis token, and invalidate all existing refresh tokens for that user.
3. Implement account lockout: maintain a Redis counter `login-attempts:{userId}` incremented on each failed login. After 5 failures, set a `login-locked:{userId}` key with a 15-minute TTL. On the next login attempt, check the lock key first and return `423 LOCKED` if present.
4. Reset the attempt counter on successful login.

**Why:**
Password reset is one of the most exploited flows in web applications. The one-hour token TTL, single-use enforcement (delete on use), and post-reset refresh token invalidation are all security requirements, not nice-to-haves. Account lockout adds brute-force protection. Both patterns appear in almost every backend role interview.

---

### Phase 16 — Async Job Queue (BullMQ)

**What to do:**
1. Install `bullmq` and `ioredis`. Create a `src/queues/emailQueue.js` that exports a `Queue` instance named `emailQueue`.
2. Move all email sending out of the request path — instead of `await sendEmail(...)` in the controller, do `await emailQueue.add('send-verification', { to, token })`.
3. Create `src/workers/emailWorker.js`: a `Worker` that processes `emailQueue` jobs. The worker calls the actual email send (Nodemailer or SendGrid). Configure `attempts: 3` and exponential backoff (`backoff: { type: 'exponential', delay: 5000 }`).
4. Run the worker as a separate process (`node src/workers/emailWorker.js`). Add it to `docker-compose.yml` as a `worker` service.
5. Test failure handling: configure a bad SMTP credential, send a registration email, and observe the job retry in the BullMQ dashboard.

**Why:**
Sending email synchronously in a request handler ties the response time to the email provider's latency. A slow or temporarily unavailable SMTP server will make your `/register` endpoint time out. Moving it to a queue decouples the request from the side effect, enables retries without user-facing error, and is the standard architecture for any action that involves external I/O. The worker-as-separate-process pattern is also important for scaling: email throughput can be increased by adding worker replicas without touching the API.

---

### Phase 17 — Message Reactions

**What to do:**
1. Add a `reactions` field to the Message schema: `Map` of emoji → array of userIds (`{ type: Map, of: [String] }`).
2. Build the `message:react` Socket.io event: use `$set` to add a userId to `reactions.{emoji}` using MongoDB's positional operator, and `$pull` to remove if the user has already reacted (toggle behaviour).
3. Broadcast `message:reaction` to the room with the updated `reactions` map after each toggle.
4. Return the `reactions` map in the message history endpoint so the initial page load shows existing reactions.
5. Index consideration: reactions are embedded, not referenced — no additional indexes needed. Explain why embedding is the right choice here.

**Why:**
Reactions are a case study in the embed-vs-reference decision. Because reactions are always read with the message and bounded in number (you wouldn't store 10,000 users in a reactions array), embedding is correct. The toggle-with-`$pull`/`$set` pattern is a common atomic-update interview question. Broadcasting the full updated map (rather than a diff) keeps client state simple.

---

### Phase 18 — Unread Message Counts

**What to do:**
1. On every `message:new` event, increment the unread counter for all room members except the sender: `INCR unread:{userId}:{roomId}`.
2. When a user fetches message history (`GET /rooms/:id/messages`), reset their counter: `DEL unread:{userId}:{roomId}`.
3. Add `GET /api/v1/users/me/unread` that pipelines `GET unread:{userId}:{roomId}` for all rooms the user is a member of and returns a map of `{ roomId: count }`.
4. Return the unread map in the connection handshake response so the UI can render badges immediately on login without a separate request.

**Why:**
Unread counts are a classic fan-out problem: one message triggers writes to N users. Redis INCR is the right tool because it is atomic (no race conditions from concurrent messages), fast (in-memory), and TTL-friendly (the key auto-cleans if the user never reads). The pipeline in step 3 avoids N serial round-trips to Redis — batch the reads.

---

### Phase 19 — Private Rooms and Invitations

**What to do:**
1. Add an `isPrivate` boolean field to the Room schema (default `false`).
2. Update the `GET /rooms` list to exclude private rooms unless the requesting user is a member.
3. Build `POST /api/v1/rooms/:id/invite`: generates an invite token stored in Redis under `invite:{token}` → `{ roomId, createdBy }` with a 48-hour TTL. Return the token (or a full invite URL) to the caller.
4. Build `POST /api/v1/rooms/join-invite?token=<token>`: look up the token, add the user to the room, delete the token (single-use).
5. Add a `requireMember` middleware used on all room-specific endpoints for private rooms: return `403 FORBIDDEN` if the user is not in `memberIds`.

**Why:**
Private rooms require layering two access control checks: the list endpoint must filter, and every per-room endpoint must gate. A common mistake is to protect the list but forget a direct `GET /rooms/:id` call. The invite token pattern — short-lived, single-use, Redis-backed — is identical to the email verification token pattern, reinforcing the same mental model.

---

### Phase 20 — Direct Messages

**What to do:**
1. Add a `type` field to the Room schema: `enum: ['group', 'dm']`, defaulting to `'group'`.
2. Build `POST /api/v1/dm`: takes a `targetUserId`. Find or create a DM room between the authenticated user and the target. The find-or-create must be idempotent: use a deterministic key — sort the two userIds alphabetically, join them, and query `Room.findOne({ type: 'dm', dmKey: sortedKey })`.
3. If no DM room exists, create one with `type: 'dm'`, `isPrivate: true`, and `dmKey` set to the sorted key. The creator is not a "room creator" in the usual sense — both users are equal members.
4. Reuse all existing message history and real-time Socket.io infrastructure — DMs are just private rooms with two members.

**Why:**
The find-or-create pattern appears in many system design scenarios: idempotent resource creation where the "natural key" is a combination of fields. The sorted userId key ensures `dm(alice, bob)` and `dm(bob, alice)` produce the same room — this is the kind of subtle correctness requirement that interviewers probe. Reusing the existing message infrastructure (rather than building a parallel DM stack) is the correct design choice.

---

### Phase 21 — Room Roles and RBAC

**What to do:**
1. Migrate the `memberIds: [String]` field to `members: [{ userId, role, joinedAt }]` with roles `owner`, `admin`, `member`. The room creator gets `owner`. Existing members (if any) become `member`.
2. Build a `requireRoomRole(minRole)` middleware that checks the requesting user's role in the room and returns `403` if insufficient.
3. Gate destructive actions: deleting a room requires `owner`; kicking a member requires `admin` or `owner`; renaming a room requires `admin` or `owner`.
4. Build `PUT /api/v1/rooms/:id/members/:userId/role`: allows an `owner` to promote/demote members.
5. Handle the ownership transfer edge case: if the `owner` leaves the room, promote the longest-tenured `admin` (or `member`) to `owner`. If no members remain, delete the room.

**Why:**
RBAC is one of the most common system design requirements. The migration from a flat array to a structured subdocument is a real schema migration scenario. The ownership transfer edge case is exactly the kind of question interviewers ask — it probes whether you have thought through the full lifecycle of a resource, not just the happy path.

---

### Phase 22 — Full-Text Message Search

**What to do:**
1. Add a MongoDB text index on `Message.content`: `messageSchema.index({ content: 'text' })`.
2. Build `GET /api/v1/rooms/:id/messages/search?q=<query>`: use `Message.find({ roomId, $text: { $search: query } }, { score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' } })`.
3. Run `.explain("executionStats")` on the search query. Confirm `winningPlan` uses the text index, not a collection scan.
4. Paginate results using limit/skip (offset pagination is acceptable here — search results are static snapshots, not real-time feeds).
5. Understand the limitations: MongoDB text search does not support partial-word matches (no prefix matching). If prefix search is needed, the alternative is a full-text search engine like Elasticsearch.

**Why:**
MongoDB's built-in text search is sufficient for many use cases and requires no additional infrastructure. The `.explain()` check is essential — without it, the query could silently fall back to a collection scan on large collections. Understanding the partial-word limitation is important for setting expectations in a system design discussion.

---

### Phase 23 — Read Receipts

**What to do:**
1. When a user fetches message history, record their read position: `SET lastread:{userId}:{roomId} {newestMessageTimestamp}`.
2. Build `GET /api/v1/rooms/:id/receipts`: for each member, return `{ userId, lastReadAt }` by pipelining `GET lastread:{userId}:{roomId}` for all members.
3. Add a `read:update` Socket.io event so clients can report their read position in real time without making an HTTP request.
4. Emit a `read:receipt` broadcast to the room when a user's read position updates, so other clients can render the "seen by" indicator immediately.

**Why:**
Read receipts combine REST (initial load) and WebSocket (real-time updates) in the same feature, which is a good exercise in knowing when to use each. The Redis STRING is the right data structure: one key per user per room, overwritten on each read. Storing this in MongoDB would generate a write on every page scroll — Redis absorbs that write load without durability overhead.

---

### Phase 24 — Prometheus Metrics

**What to do:**
1. Install `prom-client`. Initialize the default metrics collector (`collectDefaultMetrics()`), which automatically tracks Node.js process metrics (CPU, memory, event loop lag).
2. Add a custom `http_requests_total` Counter with labels `method`, `route`, and `status_code`. Increment it in an Express middleware that runs after the route handler.
3. Add a custom `http_request_duration_seconds` Histogram. Record the duration of each request using `process.hrtime()`.
4. Add a `socket_connections_active` Gauge. Increment on `connection`, decrement on `disconnect`.
5. Expose `GET /metrics` — this endpoint returns the Prometheus text format. Add a Prometheus scrape config pointing to it, and build a Grafana dashboard showing the four golden signals: latency, traffic, errors, and saturation.

**Why:**
Observability is the property of a system that makes its internal state inferrable from external outputs. The four golden signals are the standard framework for answering "is my service healthy?" in production. Understanding the difference between Counter (always increasing), Gauge (can go up or down), and Histogram (measures distributions) is a standard SRE/backend interview topic. The `socket_connections_active` Gauge is a good example of why Gauge exists — it represents a current state, not a cumulative count.

---

## Self-Review Checklist (per MR)

- [ ] Is `passwordHash` excluded from all User response shapes?
- [ ] Are all protected routes guarded by the JWT middleware?
- [ ] Is the Socket.io auth middleware rejecting connections with invalid tokens?
- [ ] Are Mongoose queries using `.lean()` for read-only operations? (equivalent to `AsNoTracking()`)
- [ ] Does the message query use the compound index? (verified with `.explain()`)
- [ ] Is cursor pagination implemented correctly — no duplicates on concurrent inserts?
- [ ] Are Redis keys namespaced consistently (`entity:id:field`)?
- [ ] Is the typing indicator expiry tested — does it clear without an explicit stop event?
- [ ] Does the disconnect handler clean up all Redis presence keys?
- [ ] Are rate limit keys using atomic `SET NX EX` for initialization, not INCR + EXPIRE separately?
- [ ] Are Nginx WebSocket upgrade headers configured?
- [ ] Are all log calls using Pino structured properties, not string concatenation?

---

## Success Criteria

The project is complete when:

1. All 8 features are implemented and the full stack starts with `docker compose up`
2. `.explain("executionStats")` confirms index usage on the message history query
3. Two API instances can exchange real-time messages via Redis pub/sub (verified locally with two ports)
4. Sticky sessions work under Nginx — WebSocket connections do not fall back to polling
5. The refresh token is revoked on logout and the next refresh attempt fails
6. The rate limiter blocks the 31st message from one user without affecting others
7. The presence system correctly removes a user who crashes without disconnecting (within 5 minutes)
8. `GET /health/ready` returns `503` when MongoDB is stopped
9. Unit tests cover auth logic and rate limiter; integration tests cover message persistence and cursor pagination
10. Swagger documents all REST endpoints with all response codes
11. Seq receives structured logs with `userId`, `roomId`, and `correlationId` as searchable fields
12. The GitLab CI/CD pipeline runs lint → test → build → deploy on every merge to `main`
13. You can explain the two-Redis-connection requirement for Socket.io scaling
14. You can explain why cursor pagination is necessary for real-time message feeds
