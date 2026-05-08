import { jest, describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createMockRedis } from '../helpers/mockRedis.js';

const mockRedis = createMockRedis();

process.env.JWT_SECRET         = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.APP_URL            = 'http://localhost:3000';

jest.unstable_mockModule('../../src/db/redis.js', () => ({ redis: mockRedis }));
jest.unstable_mockModule('../../src/socket/adapter.js', () => ({
  pubClient: {}, subClient: {}, closeAdapterConnections: async () => {},
}));
jest.unstable_mockModule('../../src/queues/email.queue.js', () => ({
  emailQueue: { add: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../../src/routes/admin.js', () => ({
  adminRouter: (_req, _res, next) => next(),
}));

const { default: supertest }            = await import('supertest');
const { app }                            = await import('../../src/app.js');
const { startMongo, stopMongo, resetDb } = await import('../helpers/setupMongo.js');
const { bootstrapUser, bearer }          = await import('../helpers/auth.js');
const { Room }                           = await import('../../src/models/Room.js');
const { Message }                        = await import('../../src/models/Message.js');

app.set('io', { to: () => ({ emit: () => {} }) });
const api = supertest(app);

beforeAll(startMongo);
afterAll(stopMongo);
afterEach(async () => {
  await resetDb();
  mockRedis._store.clear();
  jest.clearAllMocks();
});

// Let fire-and-forget microtasks (markRead, resetUnread) settle
const settle = () => new Promise(resolve => setImmediate(resolve));

// ─── helpers ─────────────────────────────────────────────────────────────────

async function seedRoom(owner) {
  const room = await Room.create({
    name: 'receipt-room',
    createdBy: owner.user._id,
    members: [{ userId: owner.user._id, role: 'owner' }],
  });
  await Message.create({
    roomId: room._id,
    senderId: owner.user._id,
    senderUsername: owner.user.username,
    content: 'hello',
    type: 'text',
  });
  return room;
}

// ─── read receipts ───────────────────────────────────────────────────────────

describe('GET /api/v1/rooms/:id/receipts', () => {
  it('returns empty receipts map when no one has fetched history', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoom(owner);

    const res = await api
      .get(`/api/v1/rooms/${room._id}/receipts`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.receipts).toEqual({});
  });

  it('records a lastread key after fetching message history', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoom(owner);

    await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(owner.accessToken));

    // Let fire-and-forget markRead resolve
    await settle();

    const key = `lastread:${owner.user._id}:${room._id}`;
    expect(mockRedis._store.has(key)).toBe(true);
  });

  it('returns sparse map with timestamp for members who read', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoom(owner);

    await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(owner.accessToken));

    await settle();

    const res = await api
      .get(`/api/v1/rooms/${room._id}/receipts`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(200);
    const receipts = res.body.data.receipts;
    const ownerId  = owner.user._id.toString();
    expect(receipts).toHaveProperty(ownerId);
    expect(typeof receipts[ownerId]).toBe('string');
    // Value is a valid ISO timestamp
    expect(() => new Date(receipts[ownerId]).toISOString()).not.toThrow();
  });

  it('only includes members who have read (omits unread members)', async () => {
    const owner  = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const guest  = await bootstrapUser({ username: 'guest', email: 'g@test.com', verified: true });

    // Create room and add guest as member directly
    const room = await Room.create({
      name: 'sparse-room',
      createdBy: owner.user._id,
      members: [
        { userId: owner.user._id, role: 'owner' },
        { userId: guest.user._id, role: 'member' },
      ],
    });
    await Message.create({
      roomId: room._id, senderId: owner.user._id,
      senderUsername: 'owner', content: 'hi', type: 'text',
    });

    // Only owner fetches history
    await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(owner.accessToken));

    await settle();

    const res = await api
      .get(`/api/v1/rooms/${room._id}/receipts`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(200);
    const receipts = res.body.data.receipts;
    expect(receipts).toHaveProperty(owner.user._id.toString());
    expect(receipts).not.toHaveProperty(guest.user._id.toString());
  });

  it('blocks a non-member from the receipts endpoint (NOT_MEMBER)', async () => {
    const owner    = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const intruder = await bootstrapUser({ username: 'bad',   email: 'b@test.com', verified: true });
    const room     = await Room.create({
      name: 'priv',
      createdBy: owner.user._id,
      isPrivate: true,
      members: [{ userId: owner.user._id, role: 'owner' }],
    });

    const res = await api
      .get(`/api/v1/rooms/${room._id}/receipts`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MEMBER');
  });
});
