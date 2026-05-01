import { redis } from "../db/redis.js";

const MESSAGE_WINDOW_SEC = 60;
const MESSAGE_MAX = 30;

/*
The fixed-window boundary burst: a user sends 30 messages at 11:59:59, the window resets at 12:00:00, and 
they send 30 more at 12:00:01 — 60 messages in 2 seconds. The sliding window counts requests within a rolling time range, 
so the window always covers exactly windowSec seconds ending at now.

ZSET approach — each request is a scored set member:

ZREMRANGEBYSCORE key -inf {now - windowMs} — remove entries older than the window
ZADD key {now} {uniqueMember} — record the current request
ZCARD key — count requests currently in the window
EXPIRE key {windowSec} — reset TTL so the key cleans itself up after inactivity
*/

export async function checkMessageRateLimit(userId) {
    const key = `rl:msg:${userId}`;
    const now = Date.now();
    const cutoff = now - MESSAGE_WINDOW_SEC * 1000;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, '-inf', cutoff);

    // Member includes Math.random() to prevent collision if two messages
    // arrive in the same millisecond — ZADD with duplicate score but unique member

    pipeline.zadd(key, now, `${now}-${Math.random()}`)
    pipeline.zcard(key);
    pipeline.expire(key, MESSAGE_WINDOW_SEC);
    const results = await pipeline.exec();

    const count = results[2][1]; // [err, value] — index 2 is the ZCARD result
    return count <= MESSAGE_MAX;
}