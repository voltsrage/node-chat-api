# Phase 1 — MongoDB Schemas, Indexes, and Seed Data

## What exists

Nothing. This is the project bootstrap. The deliverable for this phase is three Mongoose models with correct indexes and a seed script that produces enough realistic data to verify query behavior.

## What needs to be built

Five steps, in order. Do not move to Phase 2 until Step 5 confirms index usage with `.explain()`.

---

## Step 1 — Project structure and Mongoose connection

Before writing any schema, create the folder layout and wire up the MongoDB connection. The structure mirrors how the Express app will be organized in Phase 2.

**Project layout:**

```
team-chat-api/
├── src/
│   ├── models/
│   │   ├── User.js
│   │   ├── Room.js
│   │   └── Message.js
│   ├── db/
│   │   └── connect.js
│   └── seed/
│       └── seed.js
├── .env
├── .env.example
└── package.json
```

**`package.json`** — install dependencies for this phase only:

```bash
npm init -y
npm install mongoose dotenv
npm install --save-dev nodemon
```

**`.env.example`:**

```
MONGO_URI=mongodb://localhost:27017/team-chat
```

**`src/db/connect.js`:**

```js
import mongoose from 'mongoose';

export async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');
}
```

---

## Step 2 — User model

`passwordHash` uses `select: false` so it is never returned in queries unless explicitly requested with `.select('+passwordHash')`. This is a schema-level guard — it must not be the only guard (the service layer must also exclude it from response shapes), but it prevents accidental exposure from careless `find()` calls.

**`src/models/User.js`:**

```js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    username:     { type: String, required: true, unique: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    displayName:  { type: String, default: null },
    avatarUrl:    { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Indexes are declared here to be explicit — never rely on Mongoose to infer
// the right index from `unique: true` alone without verification.
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 },    { unique: true });

export const User = mongoose.model('User', userSchema);
```

---

## Step 3 — Room model

`memberIds` is an array of ObjectIds. This works for rooms with up to a few hundred members. The PRD documents this limit — if a room could have thousands, a separate `RoomMembership` collection with compound indexes on `{ roomId, userId }` is the correct design. Record that trade-off explicitly in a code comment so it surfaces during review.

**`src/models/Room.js`:**

```js
import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: null },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Array approach: correct for < ~500 members. Beyond that, use a RoomMembership
    // collection with { roomId: 1, userId: 1 } compound index instead.
    memberIds:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

roomSchema.index({ name: 1 },        { unique: true });
roomSchema.index({ memberIds: 1 });             // "which rooms does user X belong to?"
roomSchema.index({ createdAt: -1 });            // sorted room listing

export const Room = mongoose.model('Room', roomSchema);
```

---

## Step 4 — Message model

`senderUsername` is denormalized. Every message read returns the sender's username — populating `senderId` on every query adds a second round-trip per message page. Since usernames rarely change and message volume is high, storing the username directly on each message is the right call. The PRD documents this trade-off: if a username changes, a migration job updates affected messages.

The compound index `{ roomId: 1, createdAt: -1 }` matches the primary query pattern exactly:

```js
Message.find({ roomId }).sort({ createdAt: -1 }).limit(50)
```

MongoDB can satisfy this query entirely from the index — it does not need to load the collection. Step 5 verifies this.

**`src/models/Message.js`:**

```js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    roomId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Room',    required: true },
    senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
    senderUsername: { type: String, required: true },  // denormalized — avoids populate on bulk reads
    content:        { type: String, required: true },
    type:           { type: String, enum: ['text', 'system'], default: 'text' },
    editedAt:       { type: Date, default: null },
    deletedAt:      { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Primary query: messages in a room ordered by time — both fields must be in the index.
messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1 });

export const Message = mongoose.model('Message', messageSchema);
```

---

## Step 5 — Seed script and `.explain()` verification

The seed script inserts 2 rooms, 5 users, and at least 100 messages spread across both rooms. Having realistic data is required before running `.explain()` — the query planner may choose a collection scan over an index scan if the collection is nearly empty.

**`src/seed/seed.js`:**

```js
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect.js';
import { User } from '../models/User.js';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';

async function seed() {
  await connectDB();

  await Promise.all([
    User.deleteMany({}),
    Room.deleteMany({}),
    Message.deleteMany({}),
  ]);

  // 5 users — passwordHash is a placeholder; real bcrypt hashing comes in Phase 3
  const users = await User.insertMany([
    { username: 'alice',   email: 'alice@example.com',   passwordHash: 'placeholder', displayName: 'Alice' },
    { username: 'bob',     email: 'bob@example.com',     passwordHash: 'placeholder', displayName: 'Bob' },
    { username: 'carol',   email: 'carol@example.com',   passwordHash: 'placeholder', displayName: 'Carol' },
    { username: 'dave',    email: 'dave@example.com',    passwordHash: 'placeholder', displayName: 'Dave' },
    { username: 'eve',     email: 'eve@example.com',     passwordHash: 'placeholder', displayName: 'Eve' },
  ]);

  // 2 rooms
  const rooms = await Room.insertMany([
    {
      name: 'general',
      description: 'General discussion',
      createdBy: users[0]._id,
      memberIds: users.map(u => u._id),
    },
    {
      name: 'engineering',
      description: 'Engineering team',
      createdBy: users[1]._id,
      memberIds: [users[0]._id, users[1]._id, users[2]._id],
    },
  ]);

  // 100+ messages across both rooms, spread over the last 7 days
  const messages = [];
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < 120; i++) {
    const sender = users[i % users.length];
    const room   = rooms[i % rooms.length];
    const age    = Math.random() * sevenDaysMs;

    messages.push({
      roomId:         room._id,
      senderId:       sender._id,
      senderUsername: sender.username,
      content:        `Seed message ${i + 1} in ${room.name}`,
      type:           'text',
      createdAt:      new Date(now - age),
    });
  }

  await Message.insertMany(messages);

  console.log(`Seeded: ${users.length} users, ${rooms.length} rooms, ${messages.length} messages`);
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
```

Run it:

```bash
node src/seed/seed.js
```

**`.explain()` verification in `mongosh`:**

Open the MongoDB shell and run the message history query with execution stats. Replace the ObjectId with an actual room ID from your seed data.

```js
db.messages
  .find(
    { roomId: ObjectId("PASTE_ROOM_ID_HERE"), createdAt: { $lt: new Date() } },
    { _id: 1, content: 1, senderUsername: 1, createdAt: 1 }
  )
  .sort({ createdAt: -1 })
  .limit(50)
  .explain("executionStats")
```

**What to verify in the output:**

| Field | Expected value |
|---|---|
| `winningPlan.inputStage.indexName` | `roomId_1_createdAt_-1` |
| `executionStats.totalDocsExamined` | Equal to `nReturned` (≤ 50) |
| `executionStats.totalKeysExamined` | Close to `nReturned` |
| `executionStats.executionStages.stage` | `FETCH` (not `COLLSCAN`) |

If `totalDocsExamined` is much larger than `nReturned`, the compound index is not being used. Check that the index was created: `db.messages.getIndexes()`.

---

## File map

| File | Status |
|---|---|
| `package.json` | New — `mongoose`, `dotenv`, `nodemon` |
| `.env.example` | New — `MONGO_URI` placeholder |
| `src/db/connect.js` | New — Mongoose connection helper |
| `src/models/User.js` | New — User schema with `select: false` on `passwordHash` |
| `src/models/Room.js` | New — Room schema with `memberIds` array approach |
| `src/models/Message.js` | New — Message schema with compound index |
| `src/seed/seed.js` | New — 2 rooms, 5 users, 120 messages |

---

## Checklist

- [ ] Step 1 — `mongoose` and `dotenv` installed; `.env.example` committed; `.env` in `.gitignore`
- [ ] Step 1 — `src/db/connect.js` created and tested (no connection errors on startup)
- [ ] Step 2 — `User` schema created; `passwordHash` has `select: false`; both unique indexes declared
- [ ] Step 3 — `Room` schema created; `memberIds` is an `ObjectId` array; three indexes declared
- [ ] Step 4 — `Message` schema created; `senderUsername` denormalized; compound index `{ roomId: 1, createdAt: -1 }` declared
- [ ] Step 5 — Seed script runs without error; `mongosh` shows 5 users, 2 rooms, 120 messages
- [ ] Step 5 — `.explain("executionStats")` on the message history query confirms `roomId_1_createdAt_-1` index is used
- [ ] Step 5 — `totalDocsExamined` equals `nReturned` in explain output (no extra documents scanned)
- [ ] Step 5 — `db.messages.getIndexes()` shows all three expected indexes on the messages collection
