import * as authService from '../services/authService.js'
import { ValidationError } from '../errors/AppError.js'
import {ApiResponse} from '../utils/ApiResponse.js'

export async function register(req, res){
    const {username, email, password} = req.body;

    if(!username || !email || !password)
        throw new ValidationError('username, email, and password are required.');
    if(password.length < 8)
        throw new ValidationError('Password must be at least 8 characters.');

    const result = await authService.register({username, email, password});
    res.status(201).json(ApiResponse.created(result));
}

export async function login(req, res){
    const {email, password} = req.body;

    if(!email || !password)
        throw new ValidationError('email and password are required.');

    const result = await authService.login({email, password});

    res.json(ApiResponse.success(result));
}

export async function refresh(req, res){
    const {refreshToken} = req.body;

    if(!refreshToken)
        throw new ValidationError('refreshToken is required.');

    const result = await authService.refresh(refreshToken);

    res.json(ApiResponse.success(result));
}

export async function logout(req, res) {
    const {refreshToken} = req.body;

    if(refreshToken) await authService.logout(refreshToken);

    res.json(ApiResponse.success(null))
}