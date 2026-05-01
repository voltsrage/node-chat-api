import jwt from 'jsonwebtoken';

// Defined now, wired into the Socket.io server in Phase 6. The JWT comes from the client's handshake auth object: io({ auth: { token: accessToken } }).

// Socket.io middleware signals failure by calling next(new Error(...)) — not by throwing. The error string 'UNAUTHORIZED' is passed to the client as the disconnect reason.
export function socketAuthenticate(socket, next){
    const token = socket.hanshake.auth?.token;

    if(!token) return next(new Error('UNAUTHORIZED'));

    try{
        socket.user = jwt.verify(token, process.env.JWT_SECRET);
        next()
    }
    catch{
        next(new Error('UNAUTHORIZED'));
    }
}