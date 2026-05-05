import * as messageService from '../services/messageService.js';
import * as unreadService from '../services/unreadService.js';
import {ApiResponse} from '../utils/ApiResponse.js';
import { parsePaginationQuery } from '../utils/paginate.js';

export async function getMessageHistory(req, res){
    const result = await messageService.getMessageHistory(req.params.id, req.query);

    // Reset the caller's unread counter for this room.
    // Fetching history == the user has read (or is about to read) these messages.
    // Fire-and-forget — a counter reset failure should not fail the history response.
    unreadService.resetUnread(req.user.sub, req.params.id).catch(() => {});

    res.json(ApiResponse.success(result));
}

export async function searchMessages(req, res){
    const {q} = req.query;
    const pagination = parsePaginationQuery(req.query);
    const result = await messageService.searchMessages(req.params.id, q, pagination);
    res.json(ApiResponse.success(result));
}