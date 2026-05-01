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
