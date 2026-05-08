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

const { default: supertest }         = await import('supertest');
const { app }                         = await import('../../src/app.js');
const { startMongo, stopMongo, resetDb } = await import('../helpers/setupMongo.js');
const { bootstrapUser, bearer }       = await import('../helpers/auth.js');

app.set('io', { to: () => ({ emit: () => {} }) });
const api = supertest(app);

beforeAll(startMongo);
afterAll(stopMongo);
afterEach(async () => {
  await resetDb();
  mockRedis._store.clear();
  jest.clearAllMocks();
});

// ─── register ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  it('creates a user and returns tokens — no passwordHash in response', async () => {
    const res = await api.post('/api/v1/auth/register').send({
      username: 'alice',
      email:    'alice@test.com',
      password: 'password123',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('returns 409 ALREADY_EXISTS for a duplicate username', async () => {
    await bootstrapUser({ username: 'alice', email: 'alice@test.com' });

    const res = await api.post('/api/v1/auth/register').send({
      username: 'alice',
      email:    'other@test.com',
      password: 'password123',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_EXISTS');
  });

  it('returns 422 when required fields are missing', async () => {
    const res = await api.post('/api/v1/auth/register').send({ username: 'bob' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('returns 422 when password is too short', async () => {
    const res = await api.post('/api/v1/auth/register').send({
      username: 'bob',
      email:    'bob@test.com',
      password: 'short',
    });

    expect(res.status).toBe(422);
  });
});

// ─── login ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  it('returns tokens for valid credentials', async () => {
    await bootstrapUser({ username: 'alice', email: 'alice@test.com', password: 'password123' });

    const res = await api.post('/api/v1/auth/login').send({
      email:    'alice@test.com',
      password: 'password123',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
  });

  it('returns 401 INVALID_CREDENTIALS for a wrong password', async () => {
    await bootstrapUser({ username: 'alice', email: 'alice@test.com', password: 'password123' });

    const res = await api.post('/api/v1/auth/login').send({
      email:    'alice@test.com',
      password: 'wrongpass',
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 INVALID_CREDENTIALS for an unknown email', async () => {
    const res = await api.post('/api/v1/auth/login').send({
      email:    'nobody@test.com',
      password: 'password123',
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/refresh', () => {
  it('issues new tokens for a valid refresh token', async () => {
    const reg = await api.post('/api/v1/auth/register').send({
      username: 'alice',
      email:    'alice@test.com',
      password: 'password123',
    });
    const { refreshToken } = reg.body.data;

    const res = await api.post('/api/v1/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
  });

  it('returns 401 for an invalid refresh token', async () => {
    const res = await api.post('/api/v1/auth/refresh').send({ refreshToken: 'not-a-token' });

    expect(res.status).toBe(401);
  });
});

// ─── logout ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('revokes the refresh token so subsequent refresh fails', async () => {
    const reg = await api.post('/api/v1/auth/register').send({
      username: 'alice',
      email:    'alice@test.com',
      password: 'password123',
    });
    const { accessToken, refreshToken } = reg.body.data;

    await api
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(accessToken))
      .send({ refreshToken });

    const retry = await api.post('/api/v1/auth/refresh').send({ refreshToken });
    expect(retry.status).toBe(401);
  });

  it('returns 401 when called without an access token', async () => {
    const res = await api.post('/api/v1/auth/logout').send({ refreshToken: 'x' });
    expect(res.status).toBe(401);
  });
});
