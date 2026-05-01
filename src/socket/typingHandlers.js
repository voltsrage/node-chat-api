import { redis } from '../db/redis.js';

const TYPING_TTL = 3; //seconds;

export function registerTypingHandlers(io, socket){
    socket.on('typing:start', async({roomId} = {}) =>{
        if(!roomId) return;

        try{
            await redis.set(
                `typing:${roomId}:${socket.user.sub}`,
                socket.user.username,
                'EX',
                TYPING_TTL
            );

            socket.to(roomId).emit('typing:update', {
                roomId,
                userId: socket.user.sub,
                username: socket.user.username,
                typing: true
            });
        }
        catch{
            // Typing is ephemeral — swallow errors silently
        }
    });

    // typing:stop does not delete the Redis key. 
    // The 3-second TTL handles cleanup automatically. 
    // The reason: if typing:stop arrives before typing:start is fully processed (a race on a loaded server), 
    // deleting the key would leave no entry to expire and the indicator would never clear. 
    // Letting the TTL expire is atomic and race-free.

    // typing:stop still broadcasts immediately so the UI can update without waiting for the TTL. 
    // The Redis key is a safety net for clients that disconnect without sending typing:stop.
    socket.on('typing:stop', async({roomId} = {}) => {
        if(!roomId) return;
        // Do NOT delete the Redis key — let the 3s TTL expire naturally
        // This prevents a race where stop arrives before start is processed

        // socket.to(roomId) emits to everyone in the room except the sender. 
        // The user typing does not need to see their own indicator.
        socket.to(roomId).emit('typing:update', {
            roomId,
            userId: socket.user.sub,
            username: socket.user.username,
            typing: false
        })
    });
}