import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: {
    del: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: {
    findById: jest.fn(),
    find: jest.fn(),
  },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

const { incrementUnread, resetUnread, getUnreadCounts, clearUnread } = await import('../../src/services/unreadService.js');
const { redis } = await import('../../src/db/redis.js');
const { Room } = await import('../../src/models/Room.js');

function makeChain(result) {
  const c = { select: jest.fn(), lean: jest.fn().mockResolvedValue(result) };
  c.select.mockReturnValue(c);
  return c;
}

function makePipeline(execResult = []) {
  return {
    get: jest.fn(),
    incr: jest.fn(),
    exec: jest.fn().mockResolvedValue(execResult),
  };
}

function uid(id) {
  return { toString: () => id };
}

describe('unreadService.incrementUnread', () => {
  beforeEach(() => jest.clearAllMocks());

  it('increments only non-sender members and skips the sender', async () => {
    const members = [
      { userId: uid('sender') },
      { userId: uid('other1') },
      { userId: uid('other2') },
    ];
    Room.findById.mockReturnValueOnce(makeChain({ members }));
    const pipeline = makePipeline([]);
    redis.pipeline.mockReturnValueOnce(pipeline);

    await incrementUnread('room1', 'sender');

    expect(pipeline.incr).toHaveBeenCalledTimes(2);
    expect(pipeline.incr).toHaveBeenCalledWith('unread:other1:room1');
    expect(pipeline.incr).toHaveBeenCalledWith('unread:other2:room1');
    expect(pipeline.incr).not.toHaveBeenCalledWith('unread:sender:room1');
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('does nothing when room does not exist', async () => {
    Room.findById.mockReturnValueOnce(makeChain(null));

    await incrementUnread('nonexistent', 'sender');

    expect(redis.pipeline).not.toHaveBeenCalled();
  });
});

describe('unreadService.getUnreadCounts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('omits rooms with zero or null unread counts', async () => {
    const rooms = [{ _id: 'r1' }, { _id: 'r2' }, { _id: 'r3' }];
    Room.find.mockReturnValueOnce(makeChain(rooms));
    const pipeline = makePipeline([
      [null, '5'],
      [null, null],
      [null, '0'],
    ]);
    redis.pipeline.mockReturnValueOnce(pipeline);

    const result = await getUnreadCounts('user1');

    expect(result).toEqual({ r1: 5 });
    expect(result.r2).toBeUndefined();
    expect(result.r3).toBeUndefined();
  });
});

describe('unreadService.resetUnread', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls redis.del with the correct unread key', async () => {
    await resetUnread('user1', 'room1');

    expect(redis.del).toHaveBeenCalledWith('unread:user1:room1');
  });
});

describe('unreadService.clearUnread', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls redis.del with the correct unread key', async () => {
    await clearUnread('user1', 'room1');

    expect(redis.del).toHaveBeenCalledWith('unread:user1:room1');
  });
});
