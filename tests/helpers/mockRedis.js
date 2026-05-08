import { jest } from '@jest/globals';

export function createMockRedis() {
  const store = new Map();

  function createPipeline() {
    const results = [];
    const p = {};

    p.get = jest.fn((k) => {
      results.push([null, store.get(k) ?? null]);
      return p;
    });
    p.del = jest.fn((k) => {
      store.delete(k);
      results.push([null, 1]);
      return p;
    });
    p.incr = jest.fn((k) => {
      const n = (parseInt(store.get(k)) || 0) + 1;
      store.set(k, String(n));
      results.push([null, n]);
      return p;
    });
    p.zadd             = jest.fn(() => { results.push([null, 1]); return p; });
    p.zremrangebyscore = jest.fn(() => { results.push([null, 0]); return p; });
    p.zcard            = jest.fn(() => { results.push([null, 1]); return p; });
    p.expire           = jest.fn(() => { results.push([null, 1]); return p; });
    p.exec             = jest.fn(async () => results);

    return p;
  }

  return {
    _store: store,

    get:    jest.fn(async (k)        => store.get(k) ?? null),
    set:    jest.fn(async (k, v)     => { store.set(k, v); return 'OK'; }),
    del:    jest.fn(async (...keys)  => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    exists: jest.fn(async (k)        => (store.has(k) ? 1 : 0)),
    getdel: jest.fn(async (k)        => { const v = store.get(k) ?? null; store.delete(k); return v; }),
    eval:   jest.fn(async ()         => 1),   // rate limiters: count=1, within limit
    ttl:    jest.fn(async ()         => 900),
    ping:   jest.fn(async ()         => 'PONG'),
    scan:   jest.fn(async ()         => ['0', []]),
    pipeline: jest.fn(createPipeline),
  };
}
