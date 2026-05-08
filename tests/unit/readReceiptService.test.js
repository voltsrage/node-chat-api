import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: { findById: jest.fn() },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

const { markRead, getRoomReceipts, clearReceipt, clearAllReceipts } = await import('../../src/services/readReceiptService.js');
const { redis } = await import('../../src/db/redis.js');
const { Room } = await import('../../src/models/Room.js');

function makeFindByIdChain(result) {
  const c = { select: jest.fn(), lean: jest.fn().mockResolvedValue(result) };
  c.select.mockReturnValue(c);
  return c;
}

function makePipeline(execResult = []) {
  return {
    get: jest.fn(),
    del: jest.fn(),
    exec: jest.fn().mockResolvedValue(execResult),
  };
}

function uid(id) {
  return { toString: () => id };
}

describe('readReceiptService.markRead', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes lastread:{userId}:{roomId} with an ISO timestamp', async () => {
    await markRead('user1', 'room1');

    expect(redis.set).toHaveBeenCalledWith(
      'lastread:user1:room1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    );
  });
});

describe('readReceiptService.getRoomReceipts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues one pipeline GET per room member', async () => {
    const members = [{ userId: uid('u1') }, { userId: uid('u2') }];
    Room.findById.mockReturnValueOnce(makeFindByIdChain({ members }));
    const pipeline = makePipeline([[null, 'ts1'], [null, null]]);
    redis.pipeline.mockReturnValueOnce(pipeline);

    await getRoomReceipts('room1');

    expect(pipeline.get).toHaveBeenCalledTimes(2);
    expect(pipeline.get).toHaveBeenCalledWith('lastread:u1:room1');
    expect(pipeline.get).toHaveBeenCalledWith('lastread:u2:room1');
  });

  it('omits members with null Redis responses from the output', async () => {
    const members = [{ userId: uid('u1') }, { userId: uid('u2') }];
    Room.findById.mockReturnValueOnce(makeFindByIdChain({ members }));
    const pipeline = makePipeline([[null, '2024-01-01T00:00:00.000Z'], [null, null]]);
    redis.pipeline.mockReturnValueOnce(pipeline);

    const result = await getRoomReceipts('room1');

    expect(result).toEqual({ u1: '2024-01-01T00:00:00.000Z' });
    expect(result.u2).toBeUndefined();
  });
});

describe('readReceiptService.clearReceipt', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the lastread key for a single user', async () => {
    await clearReceipt('user1', 'room1');

    expect(redis.del).toHaveBeenCalledWith('lastread:user1:room1');
  });
});

describe('readReceiptService.clearAllReceipts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pipelines DEL for every member and executes', async () => {
    const members = [{ userId: uid('u1') }, { userId: uid('u2') }];
    const pipeline = makePipeline([]);
    redis.pipeline.mockReturnValueOnce(pipeline);

    await clearAllReceipts('room1', members);

    expect(pipeline.del).toHaveBeenCalledTimes(2);
    expect(pipeline.del).toHaveBeenCalledWith('lastread:u1:room1');
    expect(pipeline.del).toHaveBeenCalledWith('lastread:u2:room1');
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('does nothing for an empty members array', async () => {
    await clearAllReceipts('room1', []);

    expect(redis.pipeline).not.toHaveBeenCalled();
  });
});
