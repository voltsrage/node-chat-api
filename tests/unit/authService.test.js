import {describe, expect, jest} from '@jest/globals';

// ESM mock — must be called before importing the module under test
jest.unstable_mockModule('../../src/models/User.js', () => ({
    User :{
        findOne: jest.fn(),
        create: jest.fn()
    }
}));

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: {
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockReturnValue(null),
        del: jest.fn().mockResolvedValue(1)
    }
}));

// Dynamic import AFTER mock registration
const {register, login } = await import('../../src/services/authService.js');
const {User} = await import('../../src/models/User.js');

describe('authService.register', () => {
    it('throws ConflictError when username is already taken', async () => {
        User.findOne.mockResolvedValueOnce({_id: 'existing-user'});

        await expect(register({username: 'alice', email: 'a@a.com', password: 'pass'}))
            .rejects.toMatchObject({code: 'USERNAME_TAKEN'});
    });

    it('hashes the password before saving', async () => {
        User.findOne.mockResolvedValue(null);
        User.create.mockResolvedValueOnce({
            _id: 'new-id', username: 'alice', email: 'a@a.com'
        })

        await register({username: 'alice', email: 'a@a.com', password: 'secret'});

        const createCall = User.create.mock.calls[0][0];
        // Password must be hashed - never stored as plaintext
        expect(createCall.passwordHash).toBeDefined();
        expect(createCall.passwordHash).not.toBe('secret');
        expect(createCall.password).toBeUndefined();
    });
})

describe('authService.login', () => {
    it('throw UnauthorizedError for unknown username', async() => {
        User.findOne.mockResolvedValue(null);

        await expect(login({username: 'nobody', password: 'x'}))
            .rejects.toMatchObject({code: 'INVALID_CREDENTIALS'});
    })
});