import { Room } from "../models/Room.js";
import { markRead } from "../services/readReceiptService.js";
import { logger } from "../utils/logger.js";

export function registerReadReceiptHandlers(io, socket){
    socket.on('read:mark', async({roomId} = {}) => {
        if(!roomId) return;

        try{
            // Verify membership — the socket user must be in the room
            // (socket.join is done on connect, so the user is in the Socket.io room,
            //  but we still verify against the DB to prevent spoofed roomIds)
            const isMember = await Room.exists({
                _id: roomId,
                memberIds: socket.user.sub
            })
            
            if(!isMember) return; // silently ignore — no error emitted

            await markRead(socket.user.sub, roomId);

            // Broadcast to all room members — including the sender so their
            // own client reflects the updated receipt state
            io.to(roomId).emit('read:update', {
                userId: socket.user.sub,
                roomId,
                readAt: new Date.toISOString()
            });
        }
        catch (err){
            logger.error({ err, roomId, userId: socket.user.sub }, 'read:mark failed');
        }
    })
}