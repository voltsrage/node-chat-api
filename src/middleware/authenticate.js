import jwt from 'jsonwebtoken'
import { UnauthorizedError } from '../errors/AppError.js'

export function authenticate(req, res, next){
    const header = req.headers.authorization;
    if(!header?.startsWith('Bearer'))
        throw new UnauthorizedError('Authorization header missing or malformed.');

    const token = header.slice(7);
    try{
        req.user = jwt.verify(token, process.env.JWT_SECRET);
    }
    catch{
        throw new UnauthorizedError('Invalid or expired token.');
    }

    next();
}