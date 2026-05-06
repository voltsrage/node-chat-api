import * as dmService from '../services/dmService.js';
import {joinUserToRoom} from '../socket/index.js';
import {ApiResponse} from '../utils/ApiResponse.js'

export async function findOrCreateDm(req, res){
    const {targetId} = req.body;
    if (!targetUserId) throw new ValidationError('targetUserId is required.', 'MISSING_FIELD');

    const room = await dmService.findOrCreateDm(req.user.sub, targetId);

    // Subscribe both users' active sockets to the DM channel so messages
    // are delivered in real time without either user needing to reconnect
    const io = req.app.get('io');
    joinUserToRoom(io, req.user.sub, room.id.toString());
    joinUserToRoom(io, targetId, room.id.toString());

    res.json(ApiResponse.success(room));
}

export async function listDms(req, res){
    const dms = await dmService.listDms(req.user.sub);
    res.json(ApiResponse.success({dms}));
}