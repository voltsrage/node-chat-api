# Phase 4 — Room Management and Redis Caching

## What exists

From Phase 3:
- `authenticate` middleware — verifies JWT, attaches `req.user.sub` (userId) and `req.user.username`
- `redis` client — `ioredis` instance with reconnect strategy
- `ApiResponse` envelope helpers
- All error classes including `NotFoundError`, `ConflictError`, `ValidationError`

## What needs to be built

Seven steps. The central concept is **cache invalidation**: the member count cached in a room document goes stale the moment a user joins or leaves. Deciding whether to invalidate immediately or accept a staleness window is a system design choice, not an implementation detail.

---

## Step 1 — Pagination helper

Both `GET /rooms` and `GET /rooms/:id/members` use offset pagination. Centralizing the shape prevents inconsistency across endpoints as the project grows.

**`src/utils/paginate.js`:**

```js
export function paginatedResponse(items, total, page, pageSize) {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export function parsePaginationQuery(query, defaults = { page: 1, pageSize: 20 }) {
  const page     = Math.max(1, parseInt(query.page)     || defaults.page);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || defaults.pageSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}
```

---

## Step 2 — Room service

`.lean()` is used on all read-only queries. It returns plain JavaScript objects instead of full Mongoose documents, skipping the overhead of instantiating virtuals, middleware, and the prototype chain. This is the equivalent of `AsNoTracking()` in Entity Framework.

`$addToSet` and `$pull` are used for join and leave. Both are atomic single-document operations — no race condition between read and write. `$addToSet` is idempotent: joining a room you are already in is a no-op rather than an error.

**`src/services/roomService.js`:**

```js
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { redis } from '../db/redis.js';
import { NotFoundError } from '../errors/AppError.js';
import { paginatedResponse } from '../utils/paginate.js';

const ROOM_CACHE_TTL = 5 * 60; // 5 minutes
const cacheKey = (id) => `room:${id}`;

export async function createRoom(userId, { name, description }) {
  const room = await Room.create({
    name,
    description: description ?? null,
    createdBy:   userId,
    memberIds:   [userId],
  });
  return toRoomResponse(room);
}

export async function listRooms({ page, pageSize, skip }) {
  const [rooms, total] = await Promise.all([
    Room.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Room.countDocuments({}),
  ]);
  return paginatedResponse(rooms.map(toRoomResponse), total, page, pageSize);
}

export async function getRoomById(roomId) {
  const cached = await redis.get(cacheKey(roomId));
  if (cached) return JSON.parse(cached);

  const room = await Room.findById(roomId).lean();
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const response = toRoomResponse(room);
  await redis.set(cacheKey(roomId), JSON.stringify(response), 'EX', ROOM_CACHE_TTL);
  return response;
}

export async function joinRoom(roomId, userId) {
  // $addToSet is idempotent — joining a room you are already in is a silent no-op
  const room = await Room.findByIdAndUpdate(
    roomId,
    { $addToSet: { memberIds: userId } },
    { new: true }
  );
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  // Invalidate immediately — stale member count in the cache would be misleading
  await redis.del(cacheKey(roomId));

  return toRoomResponse(room);
}

export async function leaveRoom(roomId, userId) {
  // $pull is idempotent — leaving a room you are not in is a silent no-op
  const room = await Room.findByIdAndUpdate(
    roomId,
    { $pull: { memberIds: userId } },
    { new: true }
  );
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  await redis.del(cacheKey(roomId));
}

export async function listMembers(roomId, { page, pageSize, skip }) {
  const room = await Room.findById(roomId).select('memberIds').lean();
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const total     = room.memberIds.length;
  const pageOfIds = room.memberIds.slice(skip, skip + pageSize);

  const members = await User.find({ _id: { $in: pageOfIds } })
    .select('username displayName avatarUrl createdAt')
    .lean();

  return paginatedResponse(members, total, page, pageSize);
}

function toRoomResponse(room) {
  return {
    id:          room._id,
    name:        room.name,
    description: room.description,
    createdBy:   room.createdBy,
    memberCount: room.memberIds.length,
    createdAt:   room.createdAt,
  };
}
```

**Cache invalidation decision (document this in a code review):**

The choice here is **invalidate on write** rather than accept a staleness window. When a user joins or leaves, `redis.del(cacheKey(roomId))` is called before the response is sent. The next `GET /rooms/:id` request misses the cache, reads from MongoDB, and repopulates it.

The alternative — letting the 5-minute TTL handle it — means a caller immediately checking the room after joining sees the old member count. For a chat application this is user-visible and confusing. The cost of the extra cache miss is negligible.

---

## Step 3 — Rooms controller

The controller handles all HTTP concerns: extracting values from `req`, input validation, calling the service, and sending the response. The service has no knowledge of `req` or `res`.

The Socket.io socket-join is stubbed with a `TODO` here in the controller — the `io` instance does not exist until Phase 6.

**`src/controllers/roomController.js`:**

```js
import * as roomService from '../services/roomService.js';
import { ValidationError } from '../errors/AppError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePaginationQuery } from '../utils/paginate.js';

export async function createRoom(req, res) {
  const { name, description } = req.body;
  if (!name) throw new ValidationError('name is required.');

  const room = await roomService.createRoom(req.user.sub, { name, description });
  res.status(201).json(ApiResponse.created(room));
}

export async function listRooms(req, res) {
  const pagination = parsePaginationQuery(req.query);
  const result = await roomService.listRooms(pagination);
  res.json(ApiResponse.success(result));
}

export async function getRoomById(req, res) {
  const room = await roomService.getRoomById(req.params.id);
  res.json(ApiResponse.success(room));
}

export async function joinRoom(req, res) {
  const room = await roomService.joinRoom(req.params.id, req.user.sub);

  // TODO Phase 6: look up the user's active socket by userId and call
  // socket.join(req.params.id) so they receive real-time messages immediately.

  res.json(ApiResponse.success(room));
}

export async function leaveRoom(req, res) {
  await roomService.leaveRoom(req.params.id, req.user.sub);
  res.json(ApiResponse.success(null));
}

export async function listMembers(req, res) {
  const pagination = parsePaginationQuery(req.query);
  const result = await roomService.listMembers(req.params.id, pagination);
  res.json(ApiResponse.success(result));
}
```

---

## Step 4 — Rooms route

The route file is thin: Swagger JSDoc + path-to-controller mappings. `authenticate` is applied once at the top via `router.use()` — every route on this router is automatically protected.

**`src/routes/rooms.js`:**

```js
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as roomController from '../controllers/roomController.js';

export const roomsRouter = Router();
roomsRouter.use(authenticate);

/**
 * @openapi
 * /rooms:
 *   post:
 *     summary: Create a room
 *     tags: [Rooms]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *     responses:
 *       '201': { description: Room created }
 *       '409': { description: Room name already taken }
 */
roomsRouter.post('/',            roomController.createRoom);

/**
 * @openapi
 * /rooms:
 *   get:
 *     summary: List all rooms (paginated)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: page,     in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       '200': { description: Paginated room list }
 */
roomsRouter.get('/',             roomController.listRooms);

/**
 * @openapi
 * /rooms/{id}:
 *   get:
 *     summary: Get room details
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Room details }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id',          roomController.getRoomById);

/**
 * @openapi
 * /rooms/{id}/join:
 *   post:
 *     summary: Join a room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Joined room }
 *       '404': { description: Room not found }
 */
roomsRouter.post('/:id/join',    roomController.joinRoom);

/**
 * @openapi
 * /rooms/{id}/leave:
 *   post:
 *     summary: Leave a room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Left room }
 *       '404': { description: Room not found }
 */
roomsRouter.post('/:id/leave',   roomController.leaveRoom);

/**
 * @openapi
 * /rooms/{id}/members:
 *   get:
 *     summary: List room members (paginated)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id,       in: path,  required: true, schema: { type: string } }
 *       - { name: page,     in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       '200': { description: Paginated member list }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id/members',  roomController.listMembers);
```

---

## Step 5 — Mount the router in app.js

Add one line in `src/app.js` in the routes section:

```js
import { roomsRouter } from './routes/rooms.js';

// After authRouter:
app.use('/api/v1/rooms', roomsRouter);
```

---

## Step 6 — Handle duplicate room name error

`Room.create()` will throw a MongoDB duplicate key error (code 11000) if the name already exists. Map it to a `ConflictError` in the global error handler so it returns 409 instead of 500.

**`src/middleware/errorHandler.js`** — add before the final `else` branch:

```js
// MongoDB duplicate key error — map to 409
if (err.code === 11000) {
  const field = Object.keys(err.keyValue ?? {})[0] ?? 'field';
  const value = err.keyValue?.[field];
  req.log.warn({ err }, 'Duplicate key violation');
  return res
    .status(409)
    .json(ApiResponse.error(`${field} '${value}' is already taken.`, 'ALREADY_EXISTS', 409));
}
```

---

## Verification

**1. Create a room:**

```bash
TOKEN="<access-token>"

curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"general","description":"General discussion"}'
# Expected: 201 with room object including memberCount: 1
```

**2. List rooms:**

```bash
curl -s http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $TOKEN"
# Expected: { data: { items: [...], total: 1, page: 1, pageSize: 20, totalPages: 1 } }
```

**3. Get room and confirm cache:**

```bash
ROOM_ID="<room-id>"

curl -s http://localhost:3000/api/v1/rooms/$ROOM_ID \
  -H "Authorization: Bearer $TOKEN"

redis-cli GET room:$ROOM_ID   # Should return the JSON blob
redis-cli TTL room:$ROOM_ID   # Should be ~300 seconds
```

**4. Join and confirm cache invalidation:**

```bash
curl -s -X POST http://localhost:3000/api/v1/rooms/$ROOM_ID/join \
  -H "Authorization: Bearer $TOKEN2"

redis-cli EXISTS room:$ROOM_ID   # Should return 0

curl -s http://localhost:3000/api/v1/rooms/$ROOM_ID \
  -H "Authorization: Bearer $TOKEN"
# Expected: memberCount: 2
```

**5. Duplicate room name returns 409:**

```bash
curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"general"}'
# Expected: 409 { error: { code: "ALREADY_EXISTS" } }
```

---

## File map

| File | Status |
|---|---|
| `src/utils/paginate.js` | New — `paginatedResponse` and `parsePaginationQuery` helpers |
| `src/services/roomService.js` | New — `createRoom`, `listRooms`, `getRoomById`, `joinRoom`, `leaveRoom`, `listMembers` |
| `src/controllers/roomController.js` | New — input validation, calls service, sends response; Phase 6 TODO for socket join |
| `src/routes/rooms.js` | New — thin: `authenticate` + Swagger JSDoc + maps paths to controller functions |
| `src/middleware/errorHandler.js` | Updated — MongoDB duplicate key error mapped to 409 |
| `src/app.js` | Updated — mount `roomsRouter` at `/api/v1/rooms` |

---

## Checklist

- [ ] Step 1 — `paginatedResponse` returns `{ items, total, page, pageSize, totalPages }`
- [ ] Step 1 — `parsePaginationQuery` clamps `pageSize` between 1 and 100
- [ ] Step 2 — `createRoom` adds the creator to `memberIds` on creation
- [ ] Step 2 — `listRooms` uses `.lean()` and sorts by `createdAt: -1`
- [ ] Step 2 — `getRoomById` checks Redis first; on miss, reads MongoDB, populates cache with 5-minute TTL
- [ ] Step 2 — `joinRoom` uses `$addToSet` (idempotent); deletes cache key after update
- [ ] Step 2 — `leaveRoom` uses `$pull` (idempotent); deletes cache key after update
- [ ] Step 2 — `listMembers` uses `.lean()`; paginates the `memberIds` array in-process before querying `User`
- [ ] Step 2 — `toRoomResponse` returns `memberCount` (integer), not the full `memberIds` array
- [ ] Step 3 — controller imports only from service, error classes, `ApiResponse`, and `paginate` — not from route
- [ ] Step 3 — all input validation (`name is required`) lives in the controller, not the service
- [ ] Step 3 — Phase 6 TODO comment present on `joinRoom` controller function
- [ ] Step 4 — route file imports only from controller and `authenticate`; no inline handler functions
- [ ] Step 4 — `roomsRouter.use(authenticate)` applied once at the top; all six routes protected
- [ ] Step 4 — Swagger JSDoc on the route file
- [ ] Step 5 — `roomsRouter` mounted at `/api/v1/rooms` in `app.js`
- [ ] Step 6 — MongoDB error code 11000 caught in `errorHandler` and returned as 409
- [ ] Verification — `GET /rooms/:id` second call served from cache (confirmed via `redis-cli GET`)
- [ ] Verification — cache key deleted immediately after `join` (confirmed via `redis-cli EXISTS`)
- [ ] Verification — next `GET` after join returns updated `memberCount`
- [ ] Verification — duplicate room name returns 409 with `ALREADY_EXISTS` code
