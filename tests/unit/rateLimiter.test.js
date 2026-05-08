import { jest } from '@jest/globals';

const mockEval = jest.fn();
const mockTtl  = jest.fn();

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: { eval: mockEval, ttl: mockTtl },
}));

const { createRateLimiter } = await import('../../src/middleware/rateLimiter.js');

describe('createRateLimiter', () => {
  const next = jest.fn();

  it('calls next() when under the limit', async () => {
    mockEval.mockResolvedValue(1); // first request

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });
    await limiter({ ip: '127.0.0.1' }, {}, next);

    expect(next).toHaveBeenCalledWith(); // no arguments = no error
  });

  it('throws TooManyRequestsError when over the limit', async () => {
    mockEval.mockResolvedValue(11); // over max of 10
    mockTtl.mockResolvedValue(45);

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });

    await expect(limiter({ ip: '127.0.0.1' }, {}, next))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('keys on req.ip — two IPs have separate counters', async () => {
    mockEval.mockClear(); // isolate from previous test calls
    mockEval.mockResolvedValue(1);

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });
    await limiter({ ip: '1.2.3.4' }, {}, jest.fn());
    await limiter({ ip: '5.6.7.8' }, {}, jest.fn());

    const keys = mockEval.mock.calls.map(call => call[2]); // third arg is the Redis key
    expect(keys[0]).toContain('1.2.3.4');
    expect(keys[1]).toContain('5.6.7.8');
    expect(keys[0]).not.toBe(keys[1]);
  });
});