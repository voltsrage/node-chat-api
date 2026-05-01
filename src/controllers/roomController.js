import * as roomService from '../services/roomService.js';
import { ValidationError } from '../errors/AppError.js';
import {ApiResponse} from '../utils/ApiResponse.js';
import { paginatedResponse, parsePaginationQuery } from '../utils/paginate.js';

export async function createRoom(req, res){
    const {name, description} = req.body;
    if(!name ) throw new ValidationError('name is required.');

    const room = await roomService.createRoom(req.user.sub, {name, description});

    res.status(201).json(ApiResponse.created(room));
}

export async function listRooms(req, res){
    const pagination = parsePaginationQuery(req.query);
    const result = await roomService.listRooms(pagination);

    res.json(ApiResponse.success(result));
}

export async function getRoomById(req, res){
    const room = await roomService.getRoomById(req.params.id);
    res.json(ApiResponse.success(room));
}

export async function joinRoom(req, res){
    const room = await roomService.joinRoom(req.params.id, req.user.sub);

    // TODO Phase 6: look up the user's active socket by userId and call
    // socket.join(req.params.id) so they receive real-time messages immediately

    res.json(ApiResponse.success(room));
}

export async function leaveRoom(req, res){
    await roomService.leaveRoom(req.params.id, req.user.sub);
    res.json(ApiResponse.success(null));
}

export async function listMembers(req, res){
    const pagination = parsePaginationQuery(req.query);
    const result = await roomService.listMembers(req.params.id, pagination);

    res.json(ApiResponse.success(result));
}