import * as messageService from '../services/messageService.js';
import * as unreadService from '../services/unreadService.js';
import * as readReceiptService from '../services/readReceiptService.js';
import {ApiResponse} from '../utils/ApiResponse.js';
import { parsePaginationQuery } from '../utils/paginate.js';

export async function searchMessages(req, res){
    const {q} = req.query;
    const pagination = parsePaginationQuery(req.query);
    const result = await messageService.searchMessages(req.params.id, q, pagination);
    res.json(ApiResponse.success(result));
}

export async function getMessageHistory(req, res){
    const result = await messageService.getMessageHistory(req.params.id, req.query);

    const userId = req.user.sub;
    const roomId = req.params.id;

    // Both operations are fire-and-forget — neither should block the response
    unreadService.resetUnread(userId, roomId).catch(() => {});

    readReceiptService.markRead(userId, roomId)
        .then(() =>  {
            // Emit read:update to the room via the io instance stored in the app
            const io = req.app.get('io');
            if(io) {
                io.to(roomId).emit('read:update', {
                    userId,
                    roomId,
                    readAt: new Date().toISOString()
                })
            }
        })
        .catch(() => {});

    res.json(ApiResponse.success(result));
}