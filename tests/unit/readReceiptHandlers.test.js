import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/models/Room.js', () => ({
  Room: { exists: jest.fn() },
  ROLE_RANK: { owner: 3, admin: 2, member: 1 },
}));

jest.unstable_mockModule('../../src/services/readReceiptService.js', () => ({
  markRead: jest.fn().mockResolvedValue(undefined),
  clearReceipt: jest.fn().mockResolvedValue(undefined),
  clearAllReceipts: jest.fn().mockResolvedValue(undefined),
  getRoomReceipts: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { registerReadReceiptHandlers } = await import('../../src/socket/readReceiptHandlers.js');
const { Room } = await import('../../src/models/Room.js');
const { markRead } = await import('../../src/services/readReceiptService.js');

function makeFixture() {
  const handlers = {};
  const ioEmitSpy = jest.fn();
  const io = { to: jest.fn().mockReturnValue({ emit: ioEmitSpy }) };
  const socket = {
    on: (event, fn) => { handlers[event] = fn; },
    user: { sub: 'user1' },
    emit: jest.fn(),
  };
  registerReadReceiptHandlers(io, socket);
  return { handlers, io, ioEmitSpy, socket };
}

describe('readReceiptHandlers - read:mark', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ignores the event when roomId is missing', async () => {
    const { handlers, ioEmitSpy } = makeFixture();

    await handlers['read:mark']({});

    expect(Room.exists).not.toHaveBeenCalled();
    expect(ioEmitSpy).not.toHaveBeenCalled();
  });

  it('silently ignores event when user is not a room member', async () => {
    const { handlers, ioEmitSpy } = makeFixture();
    Room.exists.mockResolvedValueOnce(null);

    await handlers['read:mark']({ roomId: 'r1' });

    expect(markRead).not.toHaveBeenCalled();
    expect(ioEmitSpy).not.toHaveBeenCalled();
  });

  it('calls markRead and broadcasts read:update for a valid member', async () => {
    const { handlers, io, ioEmitSpy } = makeFixture();
    Room.exists.mockResolvedValueOnce({ _id: 'r1' });

    await handlers['read:mark']({ roomId: 'r1' });

    expect(markRead).toHaveBeenCalledWith('user1', 'r1');
    expect(io.to).toHaveBeenCalledWith('r1');
    expect(ioEmitSpy).toHaveBeenCalledWith(
      'read:update',
      expect.objectContaining({ userId: 'user1', roomId: 'r1' })
    );
  });
});
