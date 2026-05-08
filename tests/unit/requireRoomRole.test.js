import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('mongoose', () => ({
  default: {
    Types: { ObjectId: { isValid: jest.fn() } },
  },
}));

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: { findOne: jest.fn() },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

const { requireRoomRole } = await import('../../src/middleware/requireRoomRole.js');
const { Room } = await import('../../src/models/Room.js');
const mongooseMod = await import('mongoose');
const isValid = mongooseMod.default.Types.ObjectId.isValid;

function makeReq(id, sub = 'user1') {
  return { params: { id }, user: { sub } };
}

describe('requireRoomRole', () => {
  const next = jest.fn();
  const res = {};

  beforeEach(() => jest.clearAllMocks());

  it('calls next() without querying DB for invalid ObjectId', async () => {
    isValid.mockReturnValueOnce(false);
    const mw = requireRoomRole('admin');

    await mw(makeReq('bad-id'), res, next);

    expect(next).toHaveBeenCalled();
    expect(Room.findOne).not.toHaveBeenCalled();
  });

  it('throws NOT_MEMBER when user has no member entry in the room', async () => {
    isValid.mockReturnValueOnce(true);
    Room.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });
    const mw = requireRoomRole('member');

    await expect(mw(makeReq('r1'), res, next))
      .rejects.toMatchObject({ code: 'NOT_MEMBER' });
    expect(next).not.toHaveBeenCalled();
  });

  it('throws INSUFFICIENT_ROLE when role rank is too low', async () => {
    isValid.mockReturnValueOnce(true);
    Room.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ members: [{ role: 'member' }] }) });
    const mw = requireRoomRole('admin');

    await expect(mw(makeReq('r1'), res, next))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.memberRole and calls next() when role is sufficient', async () => {
    isValid.mockReturnValueOnce(true);
    Room.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ members: [{ role: 'admin' }] }) });
    const req = makeReq('r1');
    const mw = requireRoomRole('admin');

    await mw(req, res, next);

    expect(req.memberRole).toBe('admin');
    expect(next).toHaveBeenCalled();
  });
});
