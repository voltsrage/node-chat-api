import {redis} from '../db/redis.js';

const ONLINE_KEY = 'online:users';
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes in ms

export async function markOnline(userId){
    await redis.zadd(ONLINE_KEY, Date.now(), userId);
}

export async function markOffline(userId, roomIds = []) {
    const pipeline = redis.pipeline();
    pipeline.zrem(ONLINE_KEY, userId);
    for(const roomId of roomIds){
        pipeline.zrem(`presence:${roomId}`, userId);
    }
    await pipeline.exec();
}

export async function joinPresence(userId, roomId) {
    await redis.zadd(`presence:${roomId}`, Date.now(), userId);
}

export async function getRoomPresence(roomId) {
    const members = await redis.zrange(`presence:${roomId}`, 0, -1);
    if(!members.length) return [];

    // Batch-check which members still have a fresh entry in online:users.
    // A single pipeline avoids N serial round-trips.
    const pipeline = redis.pipeline();
    for(const userId of members) pipeline.zscore(ONLINE_KEY, userId);
    const results = await pipeline.exec();

    const cutoff = Date.now() - STALE_THRESHOLD;

    return members.filter((_, i) => {
        const score = results[i][1]; // pipeline returns [err, value] tuples
        return score != null && Number(score) >= cutoff;
    });
}

// Called by the eviction job — returns the count of removed entries
export async function evictStaleUsers() {
    const cutoff = Date.now() - STALE_THRESHOLD;
    return redis.zremrangebyscore(ONLINE_KEY, '-inf', cutoff);
}