import * as roomService from '../services/roomService.js';
import { ValidationError } from '../errors/AppError.js';
import {ApiResponse} from '../utils/ApiResponse.js';
import { paginatedResponse, parsePaginationQuery } from '../utils/paginate.js';
import { joinUserToRoom } from '../socket/index.js';

export async function createRoom(req, res){
    const {name, description, isPrivate} = req.body;
    if(!name ) throw new ValidationError('name is required.');

    const room = await roomService.createRoom(req.user.sub, {name, description, isPrivate});

    res.status(201).json(ApiResponse.created(room));
}

export async function listRooms(req, res){
    const pagination = parsePaginationQuery(req.query);

    const result = await roomService.listRooms(pagination, req.user.sub);

    res.json(ApiResponse.success(result));
}

export async function getRoomById(req, res){
    const room = await roomService.getRoomById(req.params.id);
    res.json(ApiResponse.success(room));
}

export async function joinRoom(req, res){
    const room = await roomService.joinRoom(req.params.id, req.user.sub);

    // Subscribe the user's active socket(s) to the room channel immediately
    // so they receive real-time messages without reconnecting
    const io = req.app.get('io');
    joinUserToRoom(io, req.user.sub, req.params.id);

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

export async function createInvite(req, res){
    const invite = await roomService.createInvite(req.params.id, req.user.sub);
    res.json(ApiResponse.success(invite));
}

export async function joinViaInvite(req, res){
    const room = await roomService.joinViaInvite(req.query.token, req.user.sub);
    res.json(ApiResponse.success(room));
}