import * as userService from '../services/userService.js';
import * as unreadService from '../services/unreadService.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export async function getMe(req, res){
    const user = await userService.getMyProfile(req.user.sub);
    res.json(ApiResponse.success(user));
}

export async function updateMe(req,res){
    const {displayName, avatarUrl} = req.body;
    const user = await userService.updateMyProfile(req.user.sub, {displayName, avatarUrl});
    res.json(ApiResponse.success(user));
}

export async function getUserById(req,res){
    const user = await userService.getUserById(req.params.id);
    res.json(ApiResponse.success(user));
}

export async function getUnreadCounts(req, res) {
    const counts = await unreadService.getUnreadCounts(req.user.sub);
    res.json(ApiResponse.success({counts}));
}