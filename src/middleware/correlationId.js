import {v4 as uuidv4} from 'uuid'

export function correlationIdMiddleware(req, res, next){
    const id = req.headers['x-correlation-id'] || uuidv4();
    req.correlationId = id;
    req.log = req.log.child({correlationId: id});
    res.setHeader('x-correlation-id', id);
    next()
}