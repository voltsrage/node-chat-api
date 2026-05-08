// Node 18 does not expose `crypto` as a bare global in Jest's VM context.
// uuid@14 (ESM) calls `crypto.randomUUID()` at the module level, so polyfill
// here before any test module is loaded.
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}
