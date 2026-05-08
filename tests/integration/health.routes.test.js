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

app.set('io', { to: () => ({ emit: () => {} }) });
const api = supertest(app);

beforeAll(startMongo);
afterAll(stopMongo);
afterEach(async () => {
  await resetDb();
  mockRedis._store.clear();
  jest.clearAllMocks();
});

// ─── liveness ────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok (no dependency checks)', async () => {
    const res = await api.get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── readiness ───────────────────────────────────────────────────────────────

describe('GET /health/ready', () => {
  it('returns 200 with both checks ok when deps are healthy', async () => {
    const res = await api.get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.mongodb).toBe('ok');
    expect(res.body.checks.redis).toBe('ok');
  });

  it('returns 503 with redis error when redis.ping throws', async () => {
    mockRedis.ping.mockRejectedValueOnce(new Error('connection refused'));

    const res = await api.get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis).toBe('error');
    expect(res.body.checks.mongodb).toBe('ok');
  });
});
