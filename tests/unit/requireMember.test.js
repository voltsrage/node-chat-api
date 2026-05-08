import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('mongoose', () => ({
  default: {
    Types: { ObjectId: { isValid: jest.fn() } },
  },
}));

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: { exists: jest.fn() },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

const { requireMember } = await import('../../src/middleware/requireMember.js');
const { Room } = await import('../../src/models/Room.js');
const mongooseMod = await import('mongoose');
const isValid = mongooseMod.default.Types.ObjectId.isValid;

function makeReq(id, sub = 'user1') {
  return { params: { id }, user: { sub } };
}

describe('requireMember', () => {
  const next = jest.fn();
  const res = {};

  beforeEach(() => jest.clearAllMocks());

  it('calls next() for invalid ObjectId without querying the DB', async () => {
    isValid.mockReturnValueOnce(false);

    await requireMember(makeReq('not-an-id'), res, next);

    expect(next).toHaveBeenCalled();
    expect(Room.exists).not.toHaveBeenCalled();
  });

  it('throws NOT_MEMBER when room is private and user is not a member', async () => {
    isValid.mockReturnValueOnce(true);
    Room.exists.mockResolvedValueOnce({ _id: 'r1' });

    await expect(requireMember(makeReq('r1'), res, next))
      .rejects.toMatchObject({ code: 'NOT_MEMBER' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a public room (exists returns null)', async () => {
    isValid.mockReturnValueOnce(true);
    Room.exists.mockResolvedValueOnce(null);

    await requireMember(makeReq('r1'), res, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next() when user is a member of a private room', async () => {
    isValid.mockReturnValueOnce(true);
    Room.exists.mockResolvedValueOnce(null);

    await requireMember(makeReq('r1', 'member1'), res, next);

    expect(next).toHaveBeenCalled();
  });
});
