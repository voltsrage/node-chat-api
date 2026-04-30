import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect.js';
import { User } from '../models/User.js';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';

async function seed() {
    await connectDB();

    await Promise.all([
        User.deleteMany({}),
        Room.deleteMany({}),
        Message.deleteMany({}),
    ]);

    // 5 users — passwordHash is a placeholder; real bcrypt hashing comes in Phase 3
    const users = await User.insertMany([
        { username: 'alice', email: 'alice@example.com', passwordHash: 'placeholder', displayName: 'Alice' },
        { username: 'bob', email: 'bob@example.com', passwordHash: 'placeholder', displayName: 'Bob' },
        { username: 'carol', email: 'carol@example.com', passwordHash: 'placeholder', displayName: 'Carol' },
        { username: 'dave', email: 'dave@example.com', passwordHash: 'placeholder', displayName: 'Dave' },
        { username: 'eve', email: 'eve@example.com', passwordHash: 'placeholder', displayName: 'Eve' },
    ]);

    // 2 rooms
    const rooms = await Room.insertMany([
        {
            name: 'general',
            description: 'General discussion',
            createdBy: users[0]._id,
            memberIds: users.map(u => u._id),
        },
        {
            name: 'engineering',
            description: 'Engineering team',
            createdBy: users[1]._id,
            memberIds: [users[0]._id, users[1]._id, users[2]._id],
        },
    ]);

    // 100+ messages across both rooms, spread over the last 7 days
    const messages = [];
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 120; i++) {
        const sender = users[i % users.length];
        const room = rooms[i % rooms.length];
        const age = Math.random() * sevenDaysMs;

        messages.push({
            roomId: room._id,
            senderId: sender._id,
            senderUsername: sender.username,
            content: `Seed message ${i + 1} in ${room.name}`,
            type: 'text',
            createdAt: new Date(now - age),
        });
    }

    await Message.insertMany(messages);

    console.log(`Seeded: ${users.length} users, ${rooms.length} rooms, ${messages.length} messages`);
    await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });