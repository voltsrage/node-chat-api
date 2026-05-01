import { io as ioc } from 'socket.io-client';
import fetch from 'node-fetch'; // or use curl steps below

// ── Setup ──────────────────────────────────────────────────────────────────
// 1. Register two users and get tokens (replace with real tokens from curl)
const TOKEN_A = '<token-for-alice>';
const TOKEN_B = '<token-for-bob>';
const ROOM_ID = '<room-id>';

// Client A connects to instance 1
const clientA = ioc('http://localhost:3000', { auth: { token: TOKEN_A } });

// Client B connects to instance 2
const clientB = ioc('http://localhost:3001', { auth: { token: TOKEN_B } });

clientB.on('message:new', (msg) => {
    console.log('Client B received message:new on instance 2:', msg.content);
    console.assert(msg.content === 'hello from instance 1');
    clientA.disconnect();
    clientB.disconnect();
    process.exit(0);
});

clientA.on('connect', () => {
    console.log('Client A connected to instance 1');
    clientA.emit('message:send', { roomId: ROOM_ID, content: 'hello from instance 1' });
});