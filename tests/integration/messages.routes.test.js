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

const { default: supertest }              = await import('supertest');
const { app }                              = await import('../../src/app.js');
const { startMongo, stopMongo, resetDb }   = await import('../helpers/setupMongo.js');
const { bootstrapUser, bearer }            = await import('../helpers/auth.js');
const { Message }                          = await import('../../src/models/Message.js');
const { Room }                             = await import('../../src/models/Room.js');

app.set('io', { to: () => ({ emit: () => {} }) });
const api = supertest(app);

beforeAll(startMongo);
afterAll(stopMongo);
afterEach(async () => {
  await resetDb();
  mockRedis._store.clear();
  jest.clearAllMocks();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function seedRoomWithMessages(owner, count = 5, { isPrivate = false } = {}) {
  const room = await Room.create({
    name: 'msg-room',
    createdBy: owner.user._id,
    isPrivate,
    members: [{ userId: owner.user._id, role: 'owner' }],
  });

  for (let i = 0; i < count; i++) {
    await Message.create({
      roomId:        room._id,
      senderId:      owner.user._id,
      senderUsername: owner.user.username,
      content:       `message ${i}`,
      type:          'text',
    });
  }

  return room;
}

// ─── message history ─────────────────────────────────────────────────────────

describe('GET /api/v1/rooms/:id/messages', () => {
  it('returns messages in descending createdAt order', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoomWithMessages(owner, 5);

    const res = await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items).toHaveLength(5);

    const timestamps = items.map(m => new Date(m.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });

  it('cursor pagination returns non-overlapping pages', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoomWithMessages(owner, 6);

    const page1 = await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .query({ limit: 3 })
      .set('Authorization', bearer(owner.accessToken));

    expect(page1.body.data.hasMore).toBe(true);
    const cursor = page1.body.data.nextCursor;

    const page2 = await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .query({ limit: 3, before: cursor })
      .set('Authorization', bearer(owner.accessToken));

    expect(page2.body.data.hasMore).toBe(false);

    const ids1 = new Set(page1.body.data.items.map(m => m.id.toString()));
    const ids2 = page2.body.data.items.map(m => m.id.toString());
    expect(ids2.some(id => ids1.has(id))).toBe(false);
  });

  it('shows [deleted] content for soft-deleted messages', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await Room.create({
      name: 'del-room',
      createdBy: owner.user._id,
      members: [{ userId: owner.user._id, role: 'owner' }],
    });
    await Message.create({
      roomId: room._id, senderId: owner.user._id,
      senderUsername: 'alice', content: 'secret', type: 'text',
      deletedAt: new Date(),
    });

    const res = await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.body.data.items[0].content).toBe('[deleted]');
  });

  it('blocks a non-member from a private room (NOT_MEMBER)', async () => {
    const owner   = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const intruder = await bootstrapUser({ username: 'bad',  email: 'b@test.com', verified: true });
    const room     = await seedRoomWithMessages(owner, 2, { isPrivate: true });

    const res = await api
      .get(`/api/v1/rooms/${room._id}/messages`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MEMBER');
  });
});

// ─── search ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/rooms/:id/messages/search', () => {
  it('returns 422 MISSING_QUERY when q is absent', async () => {
    const owner = await bootstrapUser({ username: 'alice', email: 'a@test.com', verified: true });
    const room  = await seedRoomWithMessages(owner, 1);

    const res = await api
      .get(`/api/v1/rooms/${room._id}/messages/search`)
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MISSING_QUERY');
  });
});
