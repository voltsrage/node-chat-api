
import {Server} from 'socket.io';
import {Room} from '../models/Room.js'
import {socketAuthenticate} from '../middleware/socketAuthenticate.js'
import { registerMessageHandlers } from './messageHandlers.js';
import { registerTypingHandlers } from './typingHandlers.js';
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

    io.use(socketAuthenticate);

    io.on('connection', async(socket) => {
        const userId = socket.user.sub;
        logger.info({ userId, socketId: socket.id }, 'Socket connected');

        // Track socket
        if(!userSockets.has(userId)) userSockets.set(userId, new Set());
        userSockets.get(userId).add(socket.id);

        // Auto-join Socket.io room channels for all rooms the user is a member of
        try{
            const rooms = await Room.find({memberIds: userId}).select('_id').lean();
            for (const room in rooms) socket.join(room._id.toString());
        }catch (err) {
            logger.error({ err, userId }, 'Failed to auto-join rooms on connect');
        }

        // Register event handlers
        registerMessageHandlers(io, socket);
        registerTypingHandlers(io, socket);

        socket.on('disconnect', (reason) => {
            logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

            const sockets = userSockets.get(userId);
            if(sockets){
                sockets.delete(socket.id);
                if(sockets.size == 0) userSockets.delete(userId);
            }

            // TODO Phase 7: remove user from presence sorted sets
        });
    });   

    return io;
}