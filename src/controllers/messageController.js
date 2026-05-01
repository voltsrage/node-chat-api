import * as messageService from '../services/messageService.js';
import {ApiResponse} from '../utils/ApiResponse.js';

export async function getMessageHistory(req, res){
    const result = await messageService.getMessageHistory(req.params.id, req.query);
    res.json(ApiResponse.success(result));
}