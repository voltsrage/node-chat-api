import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: {
    findById: jest.fn(),
    deleteOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    exists: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
    create: jest.fn(),
  },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: {
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/services/unreadService.js', () => ({
  clearUnread: jest.fn().mockResolvedValue(undefined),
  incrementUnread: jest.fn().mockResolvedValue(undefined),
  resetUnread: jest.fn().mockResolvedValue(undefined),
  getUnreadCounts: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule('../../src/services/readReceiptService.js', () => ({
  clearReceipt: jest.fn().mockResolvedValue(undefined),
  clearAllReceipts: jest.fn().mockResolvedValue(undefined),
  markRead: jest.fn().mockResolvedValue(undefined),
  getRoomReceipts: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule('../../src/models/User.js', () => ({
  User: { findOne: jest.fn(), create: jest.fn() },
}));

const { leaveRoom, kickMember, setMemberRole, deleteRoom } = await import('../../src/services/roomService.js');
const { Room } = await import('../../src/models/Room.js');

function uid(id) {
  return { toString: () => id };
}

function makeRoom(id, membersSpec) {
  const doc = {
    _id: id,
    name: 'Test',
    description: null,
    createdBy: membersSpec[0]?.uid ?? id,
    isPrivate: false,
    type: 'group',
    createdAt: new Date(),
    save: jest.fn().mockResolvedValue(undefined),
  };
  doc.members = membersSpec.map(({ uid: u, role }) => ({ userId: uid(u), role }));
  doc.toObject = function () {
    return {
      _id: this._id,
      name: this.name,
      description: this.description,
      createdBy: this.createdBy,
      members: this.members,
      isPrivate: this.isPrivate,
      type: this.type,
      createdAt: this.createdAt,
    };
  };
  return doc;
}

describe('roomService.leaveRoom', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transfers ownership to oldest admin when owner leaves', async () => {
    const room = makeRoom('r1', [
      { uid: 'owner1', role: 'owner' },
      { uid: 'admin1', role: 'admin' },
      { uid: 'member1', role: 'member' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await leaveRoom('r1', 'owner1');

    expect(room.members.find(m => m.userId.toString() === 'admin1').role).toBe('owner');
    expect(room.save).toHaveBeenCalled();
  });

  it('transfers ownership to oldest member when no admin exists', async () => {
    const room = makeRoom('r1', [
      { uid: 'owner1', role: 'owner' },
      { uid: 'member1', role: 'member' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await leaveRoom('r1', 'owner1');

    expect(room.members.find(m => m.userId.toString() === 'member1').role).toBe('owner');
    expect(room.save).toHaveBeenCalled();
  });

  it('deletes room and returns null when owner is last member', async () => {
    const room = makeRoom('r1', [{ uid: 'owner1', role: 'owner' }]);
    Room.findById.mockResolvedValueOnce(room);

    const result = await leaveRoom('r1', 'owner1');

    expect(result).toBeNull();
    expect(Room.deleteOne).toHaveBeenCalledWith({ _id: 'r1' });
  });
});

describe('roomService.kickMember', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects kicking the room owner (KICK_OWNER)', async () => {
    const room = makeRoom('r1', [
      { uid: 'admin1', role: 'admin' },
      { uid: 'owner1', role: 'owner' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await expect(kickMember('r1', 'admin1', 'owner1'))
      .rejects.toMatchObject({ code: 'KICK_OWNER' });
  });

  it('rejects admin kicking another admin (INSUFFICIENT_ROLE)', async () => {
    const room = makeRoom('r1', [
      { uid: 'admin1', role: 'admin' },
      { uid: 'admin2', role: 'admin' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await expect(kickMember('r1', 'admin1', 'admin2'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('roomService.setMemberRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects invalid role value without querying DB (INVALID_ROLE)', async () => {
    await expect(setMemberRole('r1', 'owner1', 'member1', 'superadmin'))
      .rejects.toMatchObject({ code: 'INVALID_ROLE' });

    expect(Room.findById).not.toHaveBeenCalled();
  });

  it('rejects changing the owner role (CHANGE_OWNER_ROLE)', async () => {
    const room = makeRoom('r1', [
      { uid: 'owner1', role: 'owner' },
      { uid: 'admin1', role: 'admin' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await expect(setMemberRole('r1', 'admin1', 'owner1', 'member'))
      .rejects.toMatchObject({ code: 'CHANGE_OWNER_ROLE' });
  });
});

describe('roomService.deleteRoom', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects non-owner attempting to delete the room (INSUFFICIENT_ROLE)', async () => {
    const room = makeRoom('r1', [
      { uid: 'owner1', role: 'owner' },
      { uid: 'admin1', role: 'admin' },
    ]);
    Room.findById.mockResolvedValueOnce(room);

    await expect(deleteRoom('r1', 'admin1'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});
