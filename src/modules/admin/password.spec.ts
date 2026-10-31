import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('uses argon2id with a random salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');

    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse battery');
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });

  it('has a stable dummy hash for timing protection that matches nothing real', async () => {
    const dummy = await dummyPasswordHash();

    expect(await dummyPasswordHash()).toBe(dummy);
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(dummy, 'correct horse battery')).toBe(false);
  });
});
