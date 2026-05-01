import * as presenceService from '../services/presenceService.js';
import {User} from '../models/User.js';
import {ApiResponse} from '../utils/ApiResponse.js';

export async function getRoomPresence(req, res) {
    const userIds = await presenceService.getRoomPresence(req.params.id);

    const users = userIds.length
        ? await User.find({_id: {$in: userIds}})
        .select('username displayName avatarUrl')
        .lean()
        : [];

    res.json(ApiResponse.success({users, count: users.length}))
}