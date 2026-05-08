import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { jest } from '@jest/globals';

// Redis is not used by messageService — mock it to avoid a real connection
jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

const { createMessage, getMessageHistory } = await import('../../src/services/messageService.js');
const { Room }    = await import('../../src/models/Room.js');
const { Message } = await import('../../src/models/Message.js');

const ROOM_ID   = new mongoose.Types.ObjectId().toString();
const SENDER_ID = new mongoose.Types.ObjectId().toString();

async function seedRoom() {
  await Room.create({
    _id: ROOM_ID,
    name: 'test',
    createdBy: SENDER_ID,
    members: [{ userId: SENDER_ID, role: 'owner' }],
  });
}

describe('getMessageHistory — cursor pagination', () => {
  it('returns newest messages first', async () => {
    await seedRoom();
    for (let i = 0; i < 5; i++) {
      await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
        content: `msg ${i}`, type: 'text' });
    }

    const result = await getMessageHistory(ROOM_ID, { limit: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();

    // Items should be in descending createdAt order
    const timestamps = result.items.map(m => new Date(m.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });

  it('page 2 contains no overlap with page 1', async () => {
    await seedRoom();
    for (let i = 0; i < 6; i++) {
      await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
        content: `msg ${i}`, type: 'text' });
    }

    const page1 = await getMessageHistory(ROOM_ID, { limit: 3 });
    const page2 = await getMessageHistory(ROOM_ID, { limit: 3, before: page1.nextCursor });

    const ids1 = new Set(page1.items.map(m => m.id.toString()));
    const ids2 = page2.items.map(m => m.id.toString());

    expect(ids2.some(id => ids1.has(id))).toBe(false); // no overlap
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('returns [deleted] for soft-deleted messages', async () => {
    await seedRoom();
    await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
      content: 'secret', type: 'text', deletedAt: new Date() });

    const result = await getMessageHistory(ROOM_ID);

    expect(result.items[0].content).toBe('[deleted]');
  });
});