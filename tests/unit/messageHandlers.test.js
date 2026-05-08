import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/messageService.js', () => ({
  createMessage: jest.fn(),
  editMessage: jest.fn(),
  deleteMessage: jest.fn(),
  toggleReaction: jest.fn(),
  getMessageHistory: jest.fn(),
  searchMessages: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/unreadService.js', () => ({
  incrementUnread: jest.fn().mockResolvedValue(undefined),
  clearUnread: jest.fn().mockResolvedValue(undefined),
  resetUnread: jest.fn().mockResolvedValue(undefined),
  getUnreadCounts: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule('../../src/socket/rateLimiter.js', () => ({
  checkMessageRateLimit: jest.fn().mockResolvedValue(true),
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { registerMessageHandlers } = await import('../../src/socket/messageHandlers.js');
const { createMessage } = await import('../../src/services/messageService.js');
const { incrementUnread } = await import('../../src/services/unreadService.js');
const { checkMessageRateLimit } = await import('../../src/socket/rateLimiter.js');

function makeFixture({ verified = true } = {}) {
  const handlers = {};
  const emitSpy = jest.fn();
  const ioEmitSpy = jest.fn();
  const io = { to: jest.fn().mockReturnValue({ emit: ioEmitSpy }) };
  const socket = {
    on: (event, fn) => { handlers[event] = fn; },
    user: { sub: 'user1', username: 'alice', verified },
    emit: emitSpy,
  };
  registerMessageHandlers(io, socket);
  return { handlers, io, socket, emitSpy, ioEmitSpy };
}

describe('messageHandlers - message:send', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits INVALID_CONTENT for whitespace-only message', async () => {
    const { handlers, emitSpy } = makeFixture();

    await handlers['message:send']({ roomId: 'r1', content: '   ' });

    expect(emitSpy).toHaveBeenCalledWith('error', { code: 'INVALID_CONTENT' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('emits UNVERIFIED for unverified users', async () => {
    const { handlers, emitSpy } = makeFixture({ verified: false });

    await handlers['message:send']({ roomId: 'r1', content: 'hello' });

    expect(emitSpy).toHaveBeenCalledWith('error', { code: 'UNVERIFIED' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('emits RATE_LIMITED when rate limit is exceeded', async () => {
    checkMessageRateLimit.mockResolvedValueOnce(false);
    const { handlers, emitSpy } = makeFixture();

    await handlers['message:send']({ roomId: 'r1', content: 'hello' });

    expect(emitSpy).toHaveBeenCalledWith('error', { code: 'RATE_LIMITED' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('emits message:new and triggers unread increment on success', async () => {
    const message = { id: 'm1', roomId: 'r1', content: 'hello' };
    checkMessageRateLimit.mockResolvedValueOnce(true);
    createMessage.mockResolvedValueOnce(message);
    const { handlers, io, ioEmitSpy } = makeFixture();

    await handlers['message:send']({ roomId: 'r1', content: 'hello' });

    expect(io.to).toHaveBeenCalledWith('r1');
    expect(ioEmitSpy).toHaveBeenCalledWith('message:new', message);
    expect(incrementUnread).toHaveBeenCalledWith('r1', 'user1');
  });
});
