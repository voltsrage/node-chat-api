# Redis Guide: Basic to Advanced

This guide explains the Redis commands used in `src/services/presenceService.js` and extends into other useful Redis patterns, ordered from basic to advanced.

---

## Background: What Is Redis?

Redis is an in-memory data store. It holds data in RAM, which makes reads and writes extremely fast (microseconds). It supports several data structures beyond simple key-value pairs: strings, lists, hashes, sets, sorted sets, and more.

In this project, Redis is used for **real-time presence tracking** — which users are online and which rooms they are in.

---

## The Data Structure Used Here: Sorted Sets

All commands in `presenceService.js` operate on **Sorted Sets** (`z*` commands). A sorted set stores:

- **Members** — unique strings (e.g. user IDs)
- **Scores** — a float associated with each member (e.g. a Unix timestamp)

Members are always ordered by score, lowest to highest. This makes sorted sets ideal for leaderboards, rate limiting, expiry queues, and — as used here — "last seen" tracking.

```
Key: "online:users"
┌─────────────────────────────────────────────────┐
│  Member     │  Score (last-seen ms timestamp)   │
│─────────────│───────────────────────────────────│
│  "user:17"  │  1746143398000                    │
│  "user:42"  │  1746143400000                    │
└─────────────────────────────────────────────────┘
```

---

## Commands Used in presenceService.js

### `zadd(key, score, member)`

Used in: `markOnline` and `joinPresence`

Adds a member with a score to the sorted set. If the member already exists, its score is updated. This is how "last seen" gets refreshed — calling `markOnline` again simply overwrites the timestamp.

```js
// Record that user:42 is online right now
await redis.zadd('online:users', Date.now(), 'user:42');
```

---

### `zrem(key, ...members)`

Used in: `markOffline`

Removes one or more members from a sorted set. Used when a user disconnects — removes them from the global online set and from every room they were in.

```js
await redis.zrem('online:users', 'user:42');
await redis.zrem('presence:room:1', 'user:42');
```

---

### `zrange(key, start, stop)`

Used in: `getRoomPresence`

Returns members by **rank** (index position, zero-based). `0` is the lowest score, `-1` means the last element (highest score). This call fetches all members in a room's presence set.

```js
// Get all user IDs in room:1, ordered by when they joined
const members = await redis.zrange('presence:room:1', 0, -1);
```

---

### `zscore(key, member)`

Used in: `getRoomPresence` (via pipeline)

Returns the score of a single member. Here it is used to look up each room member's last-seen timestamp from the global `online:users` set, so stale users can be filtered out.

```js
const score = await redis.zscore('online:users', 'user:42');
// score is a string like "1746143400000", or null if the member doesn't exist
```

---

### `zremrangebyscore(key, min, max)`

Used in: `evictStaleUsers`

Removes all members whose score falls within the given range. The special strings `'-inf'` and `'+inf'` represent negative and positive infinity. Used by the eviction job to purge users whose last-seen timestamp is older than 5 minutes.

```js
const cutoff = Date.now() - 5 * 60 * 1000;
const removedCount = await redis.zremrangebyscore('online:users', '-inf', cutoff);
```

---

### `pipeline()` / `.exec()`

Used in: `markOffline` and `getRoomPresence`

A pipeline batches multiple commands into a single network round-trip. Without it, N commands = N round-trips. With it, N commands = 1 round-trip, which is critical in hot paths like presence checks.

```js
const pipeline = redis.pipeline();
pipeline.zrem('online:users', 'user:42');
pipeline.zrem('presence:room:1', 'user:42');
pipeline.zrem('presence:room:2', 'user:42');
const results = await pipeline.exec();
// results is an array of [error, value] tuples, one per command
```

> **Note:** Pipeline results come back as `[err, value]` tuples — index `[0]` is the error, `[1]` is the value. This is why `presenceService.js` accesses `results[i][1]`.

---

## Other Useful Redis Commands

### Strings (simplest structure)

```js
// SET a value with an optional expiry
await redis.set('session:abc123', userId);
await redis.set('session:abc123', userId, 'EX', 3600); // expires in 1 hour

// GET a value
const id = await redis.get('session:abc123');

// Atomic increment (great for counters)
await redis.incr('message:count');
await redis.incrby('message:count', 5);

// Delete a key
await redis.del('session:abc123');

// Check if a key exists
const exists = await redis.exists('session:abc123'); // 1 or 0

// Set expiry on an existing key (seconds)
await redis.expire('session:abc123', 3600);

// Get remaining time-to-live in seconds (-1 = no expiry, -2 = doesn't exist)
const ttl = await redis.ttl('session:abc123');
```

---

### Hashes (object-like storage)

A hash maps field names to values under one key — useful for storing structured objects without serializing to JSON.

```js
// Set individual fields
await redis.hset('user:42', 'name', 'Alice', 'status', 'away');

// Get one field
const name = await redis.hget('user:42', 'name');

// Get all fields and values
const user = await redis.hgetall('user:42'); // { name: 'Alice', status: 'away' }

// Delete a field
await redis.hdel('user:42', 'status');

// Check if a field exists
const hasField = await redis.hexists('user:42', 'name'); // 1 or 0
```

---

### Lists (queues and stacks)

Lists are ordered sequences — great for message queues, activity feeds, or job queues.

```js
// Push to the right (tail) — enqueue
await redis.rpush('notifications:user:42', JSON.stringify({ type: 'mention' }));

// Push to the left (head) — stack push
await redis.lpush('recent:rooms', 'room:1');

// Pop from the left — dequeue (FIFO with rpush + lpop)
const job = await redis.lpop('job:queue');

// Get a range of elements (like zrange but no scores)
const items = await redis.lrange('recent:rooms', 0, 9); // first 10

// Get list length
const len = await redis.llen('notifications:user:42');
```

---

### Sets (unordered unique members)

Sets store unique strings with no scores — good for tracking membership when order and rank don't matter.

```js
// Add members
await redis.sadd('room:1:members', 'user:42', 'user:17');

// Remove a member
await redis.srem('room:1:members', 'user:42');

// Check membership
const isMember = await redis.sismember('room:1:members', 'user:42'); // 1 or 0

// Get all members
const members = await redis.smembers('room:1:members');

// Set intersection (users in both room:1 and room:2)
const both = await redis.sinter('room:1:members', 'room:2:members');

// Set union (users in either room)
const either = await redis.sunion('room:1:members', 'room:2:members');
```

---

### More Sorted Set Commands

```js
// Count members with scores in a range
const count = await redis.zcount('online:users', cutoff, '+inf');

// Get members with their scores
const withScores = await redis.zrange('online:users', 0, -1, 'WITHSCORES');
// returns ['user:17', '1746143398000', 'user:42', '1746143400000']

// Get members in a score range (by score, not rank)
const recent = await redis.zrangebyscore('online:users', cutoff, '+inf');

// Get rank of a member (0 = lowest score)
const rank = await redis.zrank('online:users', 'user:42');

// Get rank from the top (0 = highest score)
const revRank = await redis.zrevrank('online:users', 'user:42');

// Get total number of members
const total = await redis.zcard('online:users');
```

---

## Advanced Patterns

### Transactions with `multi` / `exec`

Unlike pipelines (which only batch for performance), `multi` gives you **atomicity** — all commands run together or none do.

```js
const result = await redis
  .multi()
  .incr('message:count')
  .lpush('recent:messages', messageId)
  .exec();
```

> **Pipeline vs Multi:** Use `pipeline` when you want to reduce round-trips. Use `multi` when the commands must succeed or fail as a unit.

---

### Pub/Sub (real-time messaging)

Redis Pub/Sub lets one client publish messages on a channel and any number of subscribers receive them instantly — useful for broadcasting events across multiple server instances.

```js
// Publisher
await redis.publish('chat:room:1', JSON.stringify({ type: 'message', text: 'Hello' }));

// Subscriber (needs a dedicated Redis connection)
const sub = redis.duplicate();
await sub.subscribe('chat:room:1');
sub.on('message', (channel, message) => {
  const event = JSON.parse(message);
  console.log(event);
});
```

---

### Lua Scripts with `eval`

Lua scripts run **atomically** on the Redis server — useful when you need read-then-write logic that must not be interrupted by other clients.

```js
// Atomically get a value and delete the key
const value = await redis.eval(
  `local v = redis.call('GET', KEYS[1])
   redis.call('DEL', KEYS[1])
   return v`,
  1,       // number of keys
  'mykey'  // KEYS[1]
);
```

---

### Key Expiry Patterns

For data that should auto-delete (sessions, rate limit windows, temporary tokens):

```js
// Set with expiry in seconds
await redis.set('reset_token:user:42', token, 'EX', 900); // 15 minutes

// Set with expiry in milliseconds
await redis.set('lock:resource', 1, 'PX', 5000); // 5 seconds

// Only set if key does NOT already exist (NX flag)
await redis.set('lock:job', 1, 'NX', 'EX', 30);

// Remove expiry from a key (make it permanent)
await redis.persist('mykey');
```

---

### Distributed Locks

For preventing race conditions across multiple server instances:

```js
// Acquire lock: SET only if not exists, with expiry
const acquired = await redis.set('lock:job:process', 1, 'NX', 'EX', 30);
// 'OK' if lock was obtained, null if already held by another instance

if (acquired) {
  try {
    await doWork();
  } finally {
    await redis.del('lock:job:process'); // always release
  }
}
```

---

## Quick Reference

| Command | Structure | What It Does |
|---|---|---|
| `set` / `get` | String | Store/retrieve a value |
| `incr` / `incrby` | String | Atomic counter |
| `expire` / `ttl` | Any | Set/check expiry |
| `del` / `exists` | Any | Delete or check a key |
| `hset` / `hget` / `hgetall` | Hash | Object field storage |
| `rpush` / `lpop` | List | FIFO queue |
| `sadd` / `sismember` / `smembers` | Set | Unique membership |
| `zadd` | Sorted Set | Add member with score |
| `zrem` | Sorted Set | Remove member |
| `zrange` | Sorted Set | Fetch members by rank |
| `zrangebyscore` | Sorted Set | Fetch members by score range |
| `zscore` | Sorted Set | Get one member's score |
| `zremrangebyscore` | Sorted Set | Bulk-remove by score range |
| `zcard` / `zcount` | Sorted Set | Count members |
| `pipeline` / `exec` | Any | Batch commands (performance) |
| `multi` / `exec` | Any | Batch commands (atomic) |
| `publish` / `subscribe` | Pub/Sub | Real-time broadcast |
| `eval` | Any | Atomic server-side Lua script |
