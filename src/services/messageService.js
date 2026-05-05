import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function getMessageHistory(roomId, { before, limit } = {}) {
    const n = Math.min(Math.max(1, parseInt(limit) || DEFAULT_LIMIT), MAX_LIMIT);

    const roomExists = await Room.exists({ _id: roomId });
    if (!roomExists) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const filter = { roomId };

    if (before) {
        const cursor = new Date(before);
        if (isNaN(cursor.getTime()))
            throw new ValidationError('before must be a valid ISO 8601 timestamp.');
        filter.createdAt = { $lt: cursor };
    }

    // Fetch n+1 to check hasMore without a separate count query
    const docs = await Message.find(filter)
        .sort({ createdAt: -1 })
        .limit(n + 1)
        .lean();

    const hasMore = docs.length > n;
    const items = hasMore ? docs.slice(0, n) : docs;

    return {
        items: items.map(toMessageResponse),
        nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
        hasMore
    };
}

export async function createMessage(roomId, { senderId, senderUsername, content }) {
    const isMember = await Room.exists({ _id: roomId, memberIds: senderId });
    if (!isMember) {
        const err = new Error('NOT_MEMBER');
        err.code = 'NOT_MEMBER';
        throw err;
    }

    const message = await Message.create({
        roomId,
        senderId,
        senderUsername,
        content: content.trim(),
        type: 'text'
    });

    return toMessageResponse(message);
}

export async function editMessage(messageId, userId, content) {
    const windowStart = new Date(Date.now() - 15 * 60 * 1000);

    const message = await Message.findOneAndUpdate(
        {
            _id: messageId,
            senderId: userId,
            deletedAt: null,
            createdAt: { $gte: windowStart },
        },
        { $set: { content: content.trim(), editedAt: new Date() } },
        { new: true }
    );

    if (!message) {
        const err = new Error('EDIT_NOT_ALLOWED');
        err.code = 'EDIT_NOT_ALLOWED';
        throw err;
    }

    return toMessageResponse(message);
}

export async function deleteMessage(messageId, userId) {
    const message = await Message.findOneAndUpdate(
        { _id: messageId, senderId: userId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { new: true }
    )

    if (!message) {
        const err = new Error('DELETE_NOT_ALLOWED');
        err.code = 'DELETE_NOT_ALLOWED';
        throw err;
    }

    return {id: message._id, roomId: message.roomId};
}

/*
    **Why `$addToSet` and not `$push`:**

    `$addToSet` is idempotent — it adds the element only if it is not already present. 
    Using `$push` would add duplicate userIds if two requests race between the check and the write. 
    `$addToSet` makes the add operation safe even in a concurrent environment.
*/

/*
    **Why two round-trips is acceptable here:**

    The alternative is a MongoDB aggregation pipeline update or a `$where` JavaScript expression — 
    both are slow and do not use indexes. Two fast indexed `findOneAndUpdate` calls on `_id` complete in ~1ms each. 
    The toggle operation is user-initiated (one at a time per user), so the latency is imperceptible and 
    the race window between the two calls is negligible at this scale.
*/
export async function toggleReaction(messageId, userId, emoji){
    // Validate emoji — count Unicode codepoints, not UTF-16 code units
    // "👍".length === 2 (surrogate pair), but [...'👍'].length === 1
    const points = [...emoji];
    if(!points.length || points.length > 4){
        throw new ValidationError('Emoji must be 1–4 codepoints.', 'INVALID_EMOJI');
    }

    // Attempt 1: add userId if it is NOT already in the array for this emoji.
    // The filter  reactions.{emoji}: { $ne: userId }  matches when:
    //   a) the emoji key does not exist yet (new reaction)
    //   b) the array exists but does not contain this userId
    const afterAdd = await Message.findOneAndUpdate(
        {
            _id: messageId,
            deletedAt: null,
            [`reactions.${emoji}`]: {$ne: userId},
        },
        {$addToSet: {[`reactions.${emoji}`]: userId}},
        {new:true}
    );

    if(afterAdd) return toMessageResponse(afterAdd);

    // Attempt 2: userId was already in the array — remove it (toggle off).
    // This is a separate round-trip; no way to do both branches in one
    // MongoDB operation without a server-side script.

    const afterRemove = await Message.findOneAndUpdate(
        {_id: messageId, deletedAt: null},
        {$pull: {[`reactions.${emoji}`]: userId}},
        {new: true}
    )

    if(!afterRemove)
        throw new NotFoundError('Message not found.', 'MESSAGE_NOT_FOUND');

    return toMessageResponse(afterRemove);

}

function toMessageResponse(msg) {
    // msg may be a Mongoose document (findOneAndUpdate) or a lean plain object
    // Mongoose Map → plain object; lean object is already plain
    const reactions = msg.reactions instanceof Map
        ? Object.fromEntries(msg.reactions)
        : (msg.reactions ?? {});

    /*
        **Empty reactions:** An unreacted message has `reactions: {}` (empty object), not `null`. 
        Clients should initialise their reaction display from this field on page load — no separate fetch needed.
     */
    return {
        id: msg._id,
        roomId: msg.roomId,
        senderId: msg.senderId,
        senderUsername: msg.senderUsername,
        content: msg.deletedAt ? '[deleted]' : msg.content,
        type: msg.type,
        reactions,
        editedAt: msg.editedAt ?? null,
        deletedAt: msg.deletedAt ?? null,
        createdAt: msg.createdAt
    }
}