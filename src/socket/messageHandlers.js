import * as messageService from '../services/messageService.js';
import { checkMessageRateLimit } from './rateLimiter.js';

const KNOWN_CODES = new Set([
    'NOT_MEMBER', 'EDIT_NOT_ALLOWED', 'DELETE_NOT_ALLOWED', 'INVALID_CONTENT', 'INVALID_EMOJI', 'MESSAGE_NOT_FOUND'
]);

// safe is a local wrapper that catches thrown errors and emits them to the client. 
// It distinguishes domain errors (known .code values) from unexpected crashes.
const safe = (socket, fn) => async (data = {}) => {
    try{
        await fn(data);
    }
    catch (err){
        const code = KNOWN_CODES.has(err.code) ? err.code : 'INTERNAL_ERROR';
        socket.emit('error', {code});
    }
};

export function registerMessageHandlers(io, socket){
    socket.on('message:send', safe(socket, async ({roomId, content}) => {
        if(!content.trim())
            return socket.emit('error', {code: 'INVALID_CONTENT'});

        // verified flag comes from the JWT decoded in socketAuthenticate
        if(!socket.user.verified)
            return socket.emit('error', {code: 'UNVERIFIED'});

        const allowed = await checkMessageRateLimit(socket.user.sub);

        if(!allowed)
            return socket.emit('error', { code: 'RATE_LIMITED' });
        
        const message = await messageService.createMessage(roomId, {
            senderId: socket.user.sub,
            senderUsername: socket.user.username,
            content,
        });

        io.to(roomId).emit('message:new', message);
    }));

    // message:edit broadcasts to the whole room — including the sender — so all open tabs update simultaneously.
    socket.on('message:edit', safe(socket, async({messageId, content}) => {
        if(!content.trim())
            return socket.emit('error', {code: 'INVALID_CONTENT'});

        const message = await messageService.editMessage(messageId, socket.user.sub, content);

        io.to(message.roomId.toString()).emit('message:edit', message);
    }));

    // message:delete broadcasts only the IDs, not the content; the client uses messageId to remove the message from its local state.
    socket.on('message:delete', safe(socket, async({messageId}) =>{
        const result = await messageService.deleteMessage(messageId, socket.user.sub);

        io.to(result.roomId.toString()).emit('message:delete', {
            messageId: result.id,
            roomId: result.roomId
        })
    }));

    socket.on('message:react', safe(socket, async({messageId, emoji} = {}) => {
        if(!emoji) return socket.emit('error', {code: 'INVALID_EMOJI'});

        const message = await messageService.toggleReaction(
            messageId,
            socket.user.sub,
            emoji
        )

        /*
            **Why `io.to()` not `socket.to()`:**

            The sender also needs to see their own reaction applied in real time. 
            `io.to(room)` broadcasts to the entire room including the sender. `socket.to(room)` excludes the sender — 
            appropriate for typing indicators (you don't need to see your own typing indicator) 
            but wrong for reactions (you need to see your own emoji added to the count).
         */
        // Broadcast only the updated reactions - not the full message.
        // The client already has the message content; it only needs to
        // update its reaction display
        io.to(message.roomId.toString()).emit('message:reaction', {
            messageId: message.id,
            roomId: message.roomId,
            reactions: message.reactions
        });
    }))
    
};