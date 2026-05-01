import * as userService from '../services/userService.js';
import { ApiResponse } from '../utils/ApiResponse';

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