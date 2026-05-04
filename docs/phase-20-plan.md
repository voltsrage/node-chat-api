# Phase 20 — Direct Messages

## What exists

From Phase 19:
- `src/models/Room.js` — Room schema with `name`, `isPrivate`, `memberIds`; no `type` or `dmKey` fields
- `src/services/roomService.js` — `listRooms`, `toRoomResponse`; both unaware of room type
- `src/socket/index.js` — exports `joinUserToRoom(io, userId, roomId)`
- All Socket.io message, presence, and unread infrastructure — works on any roomId

## What needs to be built

Four steps. The design principle: **DMs are private rooms with two members and a deterministic identity key**. Zero new Socket.io handlers, zero new message storage logic, zero new presence logic. Every feature built in Phases 6–18 works unchanged for DMs because it operates on `roomId` — the room type is irrelevant to those systems.

The one new concept is the **find-or-create pattern** with a sorted composite key. The key insight: `dm(alice, bob)` and `dm(bob, alice)` must produce the same room. Sorting the two userIds before joining them ensures that regardless of who initiates, the lookup key is identical.

---

## Step 1 — Room schema: type and dmKey

**`src/models/Room.js`** — add two fields and update `name`:

```js
// Make name sparse — DM rooms use dmKey as their natural identity, not a human name
name: {
  type:   String,
  trim:   true,
  sparse: true,    // null values do not participate in the unique index
},

type: {
  type:    String,
  enum:    ['group', 'dm'],
  default: 'group',
},

// Deterministic identity key for DM rooms: sorted(userId1, userId2).join(':')
// sparse: true — only DM rooms have a dmKey; group rooms leave it undefined
dmKey: {
  type:   String,
  unique: true,
  sparse: true,
},
```

**Why `sparse: true` on both `name` and `dmKey`:**

A non-sparse unique index treats `null` as a value. Two group rooms with `dmKey: undefined` would both be indexed as `null` — the second create would throw a duplicate key error. `sparse: true` tells MongoDB to skip documents where the field is absent or `null`, so only defined values participate in the uniqueness check.

**The consequence for `name`:** Group rooms must still provide a name (enforced in the controller with `if (!name) throw new ValidationError`). DM rooms set `name` to the `dmKey` value internally — clients never see it because DMs are excluded from `GET /rooms`.

---

## Step 2 — DM service

**`src/services/dmService.js`:**

```js
import { randomBytes } from 'crypto';
import { Room }          from '../models/Room.js';
import { User }          from '../models/User.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

function buildDmKey(id1, id2) {
  // Sort alphabetically so buildDmKey(alice, bob) === buildDmKey(bob, alice)
  // String comparison on ObjectId hex strings is stable across calls
  return [id1.toString(), id2.toString()].sort().join(':');
}

function toDmResponse(room) {
  return {
    id:        room._id,
    type:      room.type,
    isPrivate: true,
    memberIds: room.memberIds,   // Clients need both IDs to display the other participant
    createdAt: room.createdAt,
  };
}

export async function findOrCreateDm(requesterId, targetId) {
  if (requesterId.toString() === targetId.toString()) {
    throw new ValidationError('Cannot start a DM with yourself.', 'SELF_DM');
  }

  // Confirm the target user exists before creating a room for them
  const target = await User.exists({ _id: targetId });
  if (!target) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

  const dmKey = buildDmKey(requesterId, targetId);

  // ── Fast path: DM already exists ────────────────────────────────────────────
  const existing = await Room.findOne({ type: 'dm', dmKey }).lean();
  if (existing) return toDmResponse(existing);

  // ── Slow path: create a new DM room ─────────────────────────────────────────
  try {
    const room = await Room.create({
      type:      'dm',
      dmKey,
      name:      dmKey,       // Internal — never shown in the group room list
      isPrivate: true,
      memberIds: [requesterId, targetId],
      createdBy: requesterId,
    });
    return toDmResponse(room);
  } catch (err) {
    // Duplicate key error (11000) — two concurrent requests raced to create
    // the same DM room. The other request won; fetch and return what it created.
    if (err.code === 11000) {
      const room = await Room.findOne({ type: 'dm', dmKey }).lean();
      if (room) return toDmResponse(room);
    }
    throw err;
  }
}
```

**The race condition and why it must be handled:**

```
Request A                          Request B
  findOne({ dmKey }) → null
                                     findOne({ dmKey }) → null
  Room.create(...)   → success
                                     Room.create(...)   → 11000 duplicate key
                                     findOne({ dmKey }) → the room A just created
                                     return existing room ✓
```

Both users opening the DM interface simultaneously (e.g., Alice opens Bob's profile at the same instant Bob opens Alice's) would trigger two concurrent `POST /dm` requests. Without the `catch(11000)` handler, one request would return a 500. The optimistic-create pattern handles this correctly: whoever loses the race fetches and returns the winner's room.

**`toDmResponse` vs `toRoomResponse`:**

DMs return `memberIds` directly so the client can identify the other participant without a separate `GET /rooms/:id/members` call. Group rooms do not expose `memberIds` (too large, not needed for list display).

---

## Step 3 — Update listRooms and toRoomResponse

`GET /rooms` should list group rooms only. A DM inbox is a separate concern — clients fetch their DM list via `GET /dm` (added below).

**`src/services/roomService.js`** — exclude DMs from group room listing:

```js
export async function listRooms({ page, pageSize, skip }, userId) {
  const filter = {
    type: { $ne: 'dm' },    // DM rooms are a separate resource, not part of the group list
    $or: [
      { isPrivate: { $ne: true } },
      { isPrivate: true, memberIds: userId },
    ],
  };

  const [rooms, total] = await Promise.all([
    Room.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Room.countDocuments(filter),
  ]);

  return paginatedResponse(rooms.map(toRoomResponse), total, page, pageSize);
}
```

**Update `toRoomResponse`** to include `type`:

```js
function toRoomResponse(room) {
  return {
    id:          room._id,
    name:        room.name,
    description: room.description ?? null,
    createdBy:   room.createdBy,
    memberCount: room.memberIds?.length ?? 0,
    isPrivate:   room.isPrivate ?? false,
    type:        room.type    ?? 'group',
    createdAt:   room.createdAt,
  };
}
```

**Add `listDms`** so clients can fetch the user's DM conversations:

```js
// src/services/dmService.js — add:
export async function listDms(userId) {
  const rooms = await Room.find({
    type:      'dm',
    memberIds: userId,
  })
    .sort({ updatedAt: -1 })   // Most recently active first
    .lean();

  return rooms.map(toDmResponse);
}
```

---

## Step 4 — DM controller, router, and socket join

**`src/controllers/dmController.js`:**

```js
import * as dmService      from '../services/dmService.js';
import { joinUserToRoom }  from '../socket/index.js';
import { ApiResponse }     from '../utils/ApiResponse.js';

export async function findOrCreateDm(req, res) {
  const { targetUserId } = req.body;
  if (!targetUserId) throw new ValidationError('targetUserId is required.', 'MISSING_FIELD');

  const room = await dmService.findOrCreateDm(req.user.sub, targetUserId);

  // Subscribe both users' active sockets to the DM channel so messages
  // are delivered in real time without either user needing to reconnect
  const io = req.app.get('io');
  joinUserToRoom(io, req.user.sub,   room.id.toString());
  joinUserToRoom(io, targetUserId,   room.id.toString());

  res.json(ApiResponse.success(room));
}

export async function listDms(req, res) {
  const dms = await dmService.listDms(req.user.sub);
  res.json(ApiResponse.success({ dms }));
}
```

**`src/routes/dm.js`:**

```js
import { Router }        from 'express';
import { authenticate }  from '../middleware/authenticate.js';
import { requireVerified } from '../middleware/requireVerified.js';
import * as dmController from '../controllers/dmController.js';

export const dmRouter = Router();
dmRouter.use(authenticate, requireVerified);

/**
 * @openapi
 * /dm:
 *   post:
 *     summary: Find or create a DM conversation with another user
 *     tags: [DM]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetUserId]
 *             properties:
 *               targetUserId: { type: string }
 *     responses:
 *       '200': { description: Existing or newly created DM room }
 *       '404': { description: Target user not found }
 *       '422': { description: Cannot DM yourself }
 */
dmRouter.post('/', dmController.findOrCreateDm);

/**
 * @openapi
 * /dm:
 *   get:
 *     summary: List all DM conversations for the authenticated user
 *     tags: [DM]
 *     responses:
 *       '200': { description: Array of DM room objects }
 */
dmRouter.get('/', dmController.listDms);
```

**`src/app.js`** — mount the DM router:

```js
import { dmRouter } from './routes/dm.js';

app.use('/api/v1/dm', dmRouter);
```

**Reusing existing infrastructure — summary:**

| Feature | How it applies to DMs |
|---|---|
| `GET /rooms/:id/messages` | Message history for any room including DMs |
| `message:send` / `message:new` | Real-time DM delivery — roomId is the DM room's `_id` |
| `requireMember` | Gates all `/:id` routes — both DM participants are members |
| `unread:{userId}:{roomId}` | Unread counts accumulate for DMs the same way |
| `presence:{roomId}` | Online presence works for DM rooms |
| Phase 14 `requireVerified` | Applied at the DM router level |

No new Socket.io events. No new MongoDB collections. The DM room is simply a group room with `type: 'dm'`, `isPrivate: true`, and a uniqueness constraint enforced by `dmKey`.

---

## Verification

**1. Idempotency — same DM room returned regardless of who initiates:**

```bash
# Alice opens a DM with Bob
curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"targetUserId":"<bob-id>"}' | jq '.data.id'
# → "<roomId>"

# Bob opens a DM with Alice — must return the same room
curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"targetUserId":"<alice-id>"}' | jq '.data.id'
# Expected: same "<roomId>" — not a new room
```

**2. Confirm the dmKey is sorted correctly:**

```bash
# mongosh
db.rooms.findOne({ type: 'dm' }, { dmKey: 1, memberIds: 1 })
# Expected: dmKey === [memberId1, memberId2].sort().join(':')
# The smaller ObjectId string is always first regardless of who created the room
```

**3. Real-time DM message delivery:**

```js
// Alice's socket connects and opens a DM with Bob (POST /dm)
// Bob's socket is already connected

// Alice sends a message
socketAlice.emit('message:send', { roomId: DM_ROOM_ID, content: 'Hey Bob!' });

// Bob receives it via the existing message:new event
socketBob.on('message:new', (msg) => {
  console.assert(msg.content === 'Hey Bob!');
  console.assert(msg.senderUsername === 'alice');
});
// No new socket events — message:send/message:new already handles DMs
```

**4. DMs excluded from GET /rooms:**

```bash
curl -s http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.items[].type'
# Expected: only "group" values — no "dm" entries

# DMs appear in GET /dm instead:
curl -s http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.dms[].type'
# Expected: "dm"
```

**5. Unread counts work for DMs:**

```bash
# Alice sends a message to the DM room
# Bob has not opened the conversation

redis-cli GET "unread:<bob-id>:<dm-room-id>"
# Expected: "1"

# Bob fetches message history
curl -s "http://localhost:3000/api/v1/rooms/$DM_ROOM_ID/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "unread:<bob-id>:<dm-room-id>"
# Expected: (nil) — reset by getMessageHistory, same as group rooms
```

**6. Cannot DM yourself:**

```bash
curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"targetUserId":"<alice-own-id>"}' | jq '.error.code'
# Expected: "SELF_DM"
```

**7. DM with non-existent user:**

```bash
curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"targetUserId":"000000000000000000000000"}' | jq '.error.code'
# Expected: "USER_NOT_FOUND"
```

**8. Concurrent DM creation race — simulate with parallel requests:**

```bash
# Fire two simultaneous requests for the same DM pair
curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"targetUserId":"<bob-id>"}' &

curl -s -X POST http://localhost:3000/api/v1/dm \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"targetUserId":"<bob-id>"}' &
wait

# mongosh — confirm only ONE DM room exists for this pair
db.rooms.countDocuments({ type: 'dm', dmKey: /<alice-id>:<bob-id>/ })
# Expected: 1 — the 11000 handler prevented a duplicate
```

---

## File map

| File | Status |
|---|---|
| `src/models/Room.js` | Updated — add `type` (enum, default 'group'), `dmKey` (unique + sparse); make `name` sparse |
| `src/services/dmService.js` | New — `findOrCreateDm` with optimistic create + 11000 race handler; `listDms`; `buildDmKey`; `toDmResponse` |
| `src/services/roomService.js` | Updated — `listRooms` excludes `type: 'dm'`; `toRoomResponse` includes `type` |
| `src/controllers/dmController.js` | New — `findOrCreateDm`, `listDms`; calls `joinUserToRoom` for both participants |
| `src/routes/dm.js` | New — `POST /` and `GET /`; `authenticate` + `requireVerified` |
| `src/app.js` | Updated — mount `dmRouter` at `/api/v1/dm` |

---

## Checklist

- [ ] Step 1 — `dmKey` index is `unique: true, sparse: true` — can explain why `sparse` is required
- [ ] Step 1 — `name` made sparse — can explain why DM rooms cannot use the existing required unique name constraint
- [ ] Step 1 — `type` defaults to `'group'` — existing rooms are unaffected by the migration
- [ ] Step 2 — `buildDmKey` sorts userId strings before joining — `dm(alice, bob) === dm(bob, alice)`
- [ ] Step 2 — `findOrCreateDm` validates `requesterId !== targetId` before any DB operations
- [ ] Step 2 — `User.exists` used for target validation — lean, no full document fetch
- [ ] Step 2 — `catch(11000)` handles the concurrent creation race — can trace through the race condition table
- [ ] Step 2 — `toDmResponse` includes `memberIds` (unlike `toRoomResponse`) — can explain why
- [ ] Step 3 — `listRooms` filter adds `type: { $ne: 'dm' }` — DMs excluded from group room list
- [ ] Step 3 — `listDms` sorts by `updatedAt` descending (most recent conversation first)
- [ ] Step 4 — `findOrCreateDm` calls `joinUserToRoom` for BOTH participants — can explain why
- [ ] Step 4 — No new Socket.io events — `message:send` / `message:new` handle DMs transparently
- [ ] Verification — Two calls with reversed user order return the same room ID
- [ ] Verification — `GET /rooms` returns no `type: 'dm'` entries
- [ ] Verification — Unread counts increment/reset for DM rooms identically to group rooms
- [ ] Verification — Concurrent POST /dm requests produce exactly one room in MongoDB
- [ ] Knowledge check — Can explain the find-or-create pattern and why `catch(11000)` is needed
- [ ] Knowledge check — Can explain why `buildDmKey` must sort and what breaks without it
- [ ] Knowledge check — Can explain why DMs need no new socket events, message service functions, or presence logic
