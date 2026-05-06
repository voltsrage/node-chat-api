
import {Server} from 'socket.io';
import {Room} from '../models/Room.js'
import {socketAuthenticate} from '../middleware/socketAuthenticate.js'
import { registerMessageHandlers } from './messageHandlers.js';
import { registerTypingHandlers } from './typingHandlers.js';
import { markOnline, markOffline, joinPresence } from '../services/presenceService.js';
import { getUnreadCounts } from '../services/unreadService.js';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './adapter.js';
import { registerReadReceiptHandlers } from './readReceiptHandlers.js';
import { logger } from '../utils/logger.js';

// userId -> Set<socketId> - tracks active connections per user
const userSockets = new Map();

export function joinUserToRoom(io, userId, roomId) {
    const socketIds = userSockets.get(userId);
    if(!socketIds?.size) return;

    for(const socketId of socketIds){
        const socket = io.sockets.sockets.get(socketId);
        socket?.join(roomId);
    }
}

export function createSocketServer(httpServer){
    const io = new Server(httpServer, {
        cors: {origin: '*'}, // Tighten to specific origins in production
    });

    // Must be set before io.use() and io.on('connection') — adapter needs
    // to be in place before any socket events flow through it
    io.adapter(createAdapter(pubClient, subClient));

    io.use(socketAuthenticate);

    io.on('connection', async(socket) => {
        const userId = socket.user.sub;
        logger.info({ userId, socketId: socket.id }, 'Socket connected');

        // Track socket
        if(!userSockets.has(userId)) userSockets.set(userId, new Set());
        userSockets.get(userId).add(socket.id);

        // Mark online and auto-join all room channels
        try{
            await markOnline(userId);

            const rooms = await Room.find({'members.userId': userId}).select('_id').lean();
            for (const room of rooms){
                const roomId = room._id.toString();
                socket.join(roomId);
                await joinPresence(userId, roomId);
            } 

            // Send unread counts to the connecting socket only (not the whole room)
            // The client uses this to initialize badge state immediately on login
            const counts = await getUnreadCounts(userId);

            // `socket.emit` (not `io.to(...).emit`) — the unread counts are personal to the connecting user, not a broadcast.
            socket.emit('unread:counts', counts);
        }catch (err) {
            logger.error({ err, userId }, 'Failed to auto-join rooms on connect');
        }

        // Register event handlers
        registerMessageHandlers(io, socket);
        registerTypingHandlers(io, socket);
        registerReadReceiptHandlers(io, socket);

        socket.on('disconnect', async (reason) => {
            logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

            const sockets = userSockets.get(userId);
            if(sockets){
                sockets.delete(socket.id);
                if(sockets.size == 0) userSockets.delete(userId);
            }

            // Only clean presence when this was the user's LAST socket
            // (multi-tab: if another tab is still open, they remain online)
            if(!userSockets.has(userId)){
                // socket.rooms contains all Socket.io channels this socket was in
                const roomIds = [...socket.rooms].filter(r => r !== socket.id);
                try {
                    await markOffline(userId, roomIds);
                }
                catch(err){
                    logger.error({ err, userId }, 'Error during socket disconnect cleanup');
                }
            }
        });
    });   

    return io;
}