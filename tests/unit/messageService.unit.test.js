import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/models/Message.js', () => ({
  Message: {
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: {
    exists: jest.fn(),
    find: jest.fn(),
  },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

const {
  getMessageHistory,
  createMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
} = await import('../../src/services/messageService.js');
const { Message } = await import('../../src/models/Message.js');
const { Room } = await import('../../src/models/Room.js');

function makeChain(result) {
  const c = { sort: jest.fn(), limit: jest.fn(), lean: jest.fn().mockResolvedValue(result) };
  c.sort.mockReturnValue(c);
  c.limit.mockReturnValue(c);
  return c;
}

function makeMsg(overrides = {}) {
  return {
    _id: 'm1',
    roomId: 'r1',
    senderId: 'user1',
    senderUsername: 'alice',
    content: 'hello',
    type: 'text',
    reactions: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('messageService.getMessageHistory', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws VALIDATION_ERROR for invalid `before` timestamp', async () => {
    Room.exists.mockResolvedValueOnce({ _id: 'r1' });

    await expect(getMessageHistory('r1', { before: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws ROOM_NOT_FOUND for unknown room', async () => {
    Room.exists.mockResolvedValueOnce(null);

    await expect(getMessageHistory('bad-room', {}))
      .rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });
});

describe('messageService.createMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws NOT_MEMBER when sender is not in the room', async () => {
    Room.exists.mockResolvedValueOnce(null);

    await expect(createMessage('r1', { senderId: 'user1', senderUsername: 'alice', content: 'hi' }))
      .rejects.toMatchObject({ code: 'NOT_MEMBER' });
  });
});

describe('messageService.editMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws EDIT_NOT_ALLOWED when message is outside edit window or not owned', async () => {
    Message.findOneAndUpdate.mockResolvedValueOnce(null);

    await expect(editMessage('m1', 'user1', 'new content'))
      .rejects.toMatchObject({ code: 'EDIT_NOT_ALLOWED' });
  });
});

describe('messageService.deleteMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws DELETE_NOT_ALLOWED when message is not owned or already deleted', async () => {
    Message.findOneAndUpdate.mockResolvedValueOnce(null);

    await expect(deleteMessage('m1', 'user1'))
      .rejects.toMatchObject({ code: 'DELETE_NOT_ALLOWED' });
  });
});

describe('messageService.toggleReaction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws INVALID_EMOJI for empty emoji string', async () => {
    await expect(toggleReaction('m1', 'user1', ''))
      .rejects.toMatchObject({ code: 'INVALID_EMOJI' });
  });

  it('throws INVALID_EMOJI for emoji with more than 4 codepoints', async () => {
    await expect(toggleReaction('m1', 'user1', '12345'))
      .rejects.toMatchObject({ code: 'INVALID_EMOJI' });
  });

  it('adds reaction on first toggle (findOneAndUpdate returns doc)', async () => {
    const msg = makeMsg({ reactions: { '👍': ['user1'] } });
    Message.findOneAndUpdate.mockResolvedValueOnce(msg);

    const result = await toggleReaction('m1', 'user1', '👍');

    expect(result.reactions).toEqual({ '👍': ['user1'] });
    expect(Message.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('removes reaction on second toggle (first update returns null, second returns doc)', async () => {
    const msg = makeMsg({ reactions: {} });
    Message.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(msg);

    const result = await toggleReaction('m1', 'user1', '👍');

    expect(result).toBeDefined();
    expect(Message.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});
