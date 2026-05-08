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

async function createRoom(token, body = { name: 'test-room' }) {
  const res = await api
    .post('/api/v1/rooms')
    .set('Authorization', bearer(token))
    .send(body);
  return res;
}

// ─── create room ─────────────────────────────────────────────────────────────

describe('POST /api/v1/rooms', () => {
  it('creator becomes the room owner', async () => {
    const { user, accessToken } = await bootstrapUser({
      username: 'alice', email: 'alice@test.com', verified: true,
    });

    const res = await createRoom(accessToken);
    expect(res.status).toBe(201);

    const roomId = res.body.data.id;
    const members = await api
      .get(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', bearer(accessToken));

    const entry = members.body.data.find(m => m.userId.toString() === user._id.toString());
    expect(entry.role).toBe('owner');
  });

  it('returns 403 UNVERIFIED when user is not email-verified', async () => {
    const { accessToken } = await bootstrapUser({
      username: 'alice', email: 'alice@test.com', verified: false,
    });

    const res = await createRoom(accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNVERIFIED');
  });

  it('returns 422 when name is missing', async () => {
    const { accessToken } = await bootstrapUser({
      username: 'alice', email: 'alice@test.com', verified: true,
    });

    const res = await createRoom(accessToken, {});
    expect(res.status).toBe(422);
  });
});

// ─── join / leave ─────────────────────────────────────────────────────────────

describe('POST /api/v1/rooms/:id/join and /leave', () => {
  it('verified user can join a public room then leave it', async () => {
    const owner = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const guest = await bootstrapUser({ username: 'guest', email: 'g@test.com', verified: true });

    const roomRes = await createRoom(owner.accessToken);
    const roomId  = roomRes.body.data.id;

    const joinRes = await api
      .post(`/api/v1/rooms/${roomId}/join`)
      .set('Authorization', bearer(guest.accessToken));
    expect(joinRes.status).toBe(200);

    const leaveRes = await api
      .post(`/api/v1/rooms/${roomId}/leave`)
      .set('Authorization', bearer(guest.accessToken));
    expect(leaveRes.status).toBe(200);

    const members = await api
      .get(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', bearer(owner.accessToken));
    const ids = members.body.data.map(m => m.userId.toString());
    expect(ids).not.toContain(guest.user._id.toString());
  });

  it('blocks a non-member from joining a private room', async () => {
    const owner = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const guest = await bootstrapUser({ username: 'guest', email: 'g@test.com', verified: true });

    const roomRes = await createRoom(owner.accessToken, { name: 'secret', isPrivate: true });
    const roomId  = roomRes.body.data.id;

    const res = await api
      .post(`/api/v1/rooms/${roomId}/join`)
      .set('Authorization', bearer(guest.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MEMBER');
  });
});

// ─── invite flow ─────────────────────────────────────────────────────────────

describe('Invite flow', () => {
  it('member creates invite, guest joins, token reuse fails', async () => {
    const owner = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const guest = await bootstrapUser({ username: 'guest', email: 'g@test.com', verified: true });

    const roomRes = await createRoom(owner.accessToken, { name: 'invite-room', isPrivate: true });
    const roomId  = roomRes.body.data.id;

    // Create invite
    const inviteRes = await api
      .post(`/api/v1/rooms/${roomId}/invite`)
      .set('Authorization', bearer(owner.accessToken));
    expect(inviteRes.status).toBe(200);
    const { token } = inviteRes.body.data;

    // Guest joins with token
    const joinRes = await api
      .post('/api/v1/rooms/join-invite')
      .query({ token })
      .set('Authorization', bearer(guest.accessToken));
    expect(joinRes.status).toBe(200);

    const members = await api
      .get(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', bearer(owner.accessToken));
    const ids = members.body.data.map(m => m.userId.toString());
    expect(ids).toContain(guest.user._id.toString());

    // Token reuse is rejected
    const reuseRes = await api
      .post('/api/v1/rooms/join-invite')
      .query({ token })
      .set('Authorization', bearer(guest.accessToken));
    expect(reuseRes.status).toBe(422);
    expect(reuseRes.body.error.code).toBe('INVALID_TOKEN');
  });
});

// ─── RBAC — kick / set role / delete ─────────────────────────────────────────

describe('RBAC operations', () => {
  async function setupRoom() {
    const owner  = await bootstrapUser({ username: 'owner',  email: 'owner@t.com',  verified: true });
    const admin  = await bootstrapUser({ username: 'admin',  email: 'admin@t.com',  verified: true });
    const member = await bootstrapUser({ username: 'member', email: 'member@t.com', verified: true });

    const roomRes = await createRoom(owner.accessToken);
    const roomId  = roomRes.body.data.id;

    // admin joins then gets promoted
    await api.post(`/api/v1/rooms/${roomId}/join`).set('Authorization', bearer(admin.accessToken));
    await api
      .put(`/api/v1/rooms/${roomId}/members/${admin.user._id}/role`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ role: 'admin' });

    // member joins
    await api.post(`/api/v1/rooms/${roomId}/join`).set('Authorization', bearer(member.accessToken));

    return { owner, admin, member, roomId };
  }

  it('admin can kick a member', async () => {
    const { admin, member, roomId } = await setupRoom();

    const res = await api
      .delete(`/api/v1/rooms/${roomId}/members/${member.user._id}`)
      .set('Authorization', bearer(admin.accessToken));
    expect(res.status).toBe(200);
  });

  it('admin cannot kick the room owner (KICK_OWNER)', async () => {
    const { admin, owner, roomId } = await setupRoom();

    const res = await api
      .delete(`/api/v1/rooms/${roomId}/members/${owner.user._id}`)
      .set('Authorization', bearer(admin.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KICK_OWNER');
  });

  it('a plain member cannot kick anyone (INSUFFICIENT_ROLE)', async () => {
    const { member, admin, roomId } = await setupRoom();

    const res = await api
      .delete(`/api/v1/rooms/${roomId}/members/${admin.user._id}`)
      .set('Authorization', bearer(member.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('owner can delete the room', async () => {
    const { owner, roomId } = await setupRoom();

    const delRes = await api
      .delete(`/api/v1/rooms/${roomId}`)
      .set('Authorization', bearer(owner.accessToken));
    expect(delRes.status).toBe(204);

    const getRes = await api
      .get(`/api/v1/rooms/${roomId}`)
      .set('Authorization', bearer(owner.accessToken));
    expect(getRes.status).toBe(404);
  });

  it('admin cannot delete the room (INSUFFICIENT_ROLE)', async () => {
    const { admin, roomId } = await setupRoom();

    const res = await api
      .delete(`/api/v1/rooms/${roomId}`)
      .set('Authorization', bearer(admin.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

// ─── ownership transfer ───────────────────────────────────────────────────────

describe('Ownership transfer on owner leave', () => {
  it('oldest admin becomes owner when owner leaves', async () => {
    const owner = await bootstrapUser({ username: 'owner', email: 'o@test.com', verified: true });
    const admin = await bootstrapUser({ username: 'admin', email: 'a@test.com', verified: true });

    const roomRes = await createRoom(owner.accessToken);
    const roomId  = roomRes.body.data.id;

    await api.post(`/api/v1/rooms/${roomId}/join`).set('Authorization', bearer(admin.accessToken));
    await api
      .put(`/api/v1/rooms/${roomId}/members/${admin.user._id}/role`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ role: 'admin' });

    await api.post(`/api/v1/rooms/${roomId}/leave`).set('Authorization', bearer(owner.accessToken));

    const members = await api
      .get(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', bearer(admin.accessToken));
    const adminEntry = members.body.data.find(m => m.userId.toString() === admin.user._id.toString());
    expect(adminEntry.role).toBe('owner');
  });
});
