import {redis} from '../db/redis.js';
import { Room } from '../models/Room.js';

// Key pattern: lastread:{userId}:{roomId}
// No TTL — a receipt from 3 months ago still meaningfully represents
// "this user was last here at that time"
const key = (userId, roomId) => `lastread:${userId}:${roomId}`;

export async function markRead(userId, roomId){
    // Overwrite on every read — always reflects the most recent visit
    await redis.set(key(userId, roomId), new Date().toISOString());
}

export async function getRoomReceipts(roomId){
    const room = await Room.findById(roomId).select('members').lean();
    if(!room) return {};

    // One pipeline round-trip for all members - same pattern as getUnreadCounts
    const pipeline = redis.pipeline();

    for(const m of room.members){
        pipeline.get(key(m.userId.toString(), roomId));
    }

    const results = await pipeline.exec();

    const receipts = {};
    for(let i = 0; i < room.members.length; i++){
        const ts = results[i][1];
        // Only include members who have read at least once — omit null entries
        if(ts) receipts[room.members[i].userId.toString()] = ts;
    }

    return receipts;
}

// Called when a user leavers a room or when a room is deleted
export async function clearReceipt(userId, roomId){
    await redis.del(key(userId,roomId));
}

// Called when a room is deleted - clears receipts for all members at once
export async function clearAllReceipts(roomId, members){
    if(!members?.length) return;
    const pipeline =redis.pipeline();
    for(const m of members){
        pipeline.del(key(m.userId.toString(), roomId));
    }

    await pipeline.exec();
}