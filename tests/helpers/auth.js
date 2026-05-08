import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

// Dynamic import so User uses whichever mongoose connection is active at call time
async function getUser() {
  const { User } = await import('../../src/models/User.js');
  return User;
}

// Create a user directly in MongoDB and return a pre-signed JWT.
// Use this in room/message/receipt tests that just need an authenticated user.
// rounds=1 keeps bcrypt fast in tests.
export async function bootstrapUser({
  username,
  email,
  password = 'password123',
  verified = false,
} = {}) {
  const User = await getUser();
  const passwordHash = await bcrypt.hash(password, 1);
  const user = await User.create({ username, email, passwordHash, verified });

  const accessToken = jwt.sign(
    { sub: user._id.toString(), username: user.username, verified },
    process.env.JWT_SECRET,
    { expiresIn: 3600 }
  );

  return { user, accessToken };
}

export function bearer(token) {
  return `Bearer ${token}`;
}
