import { AdminRole as R, hasRole, requiredRole } from './admin.enums.js';

describe('hasRole (minimum level: support < moderator < super_admin)', () => {
  it.each([
    [R.Support, R.Support, true],
    [R.Support, R.Moderator, false],
    [R.Support, R.SuperAdmin, false],
    [R.Moderator, R.Support, true],
    [R.Moderator, R.Moderator, true],
    [R.Moderator, R.SuperAdmin, false],
    [R.SuperAdmin, R.Support, true],
    [R.SuperAdmin, R.Moderator, true],
    [R.SuperAdmin, R.SuperAdmin, true],
  ])('%s meets %s: %s', (actual, required, expected) => {
    expect(hasRole(actual, required)).toBe(expected);
  });
});

describe('requiredRole (fail closed)', () => {
  it.each(['GET', 'HEAD', 'get'])(
    'a %s without @Roles needs any staff role (S2)',
    (method) => {
      expect(requiredRole(method, undefined)).toBe(R.Support);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post'])(
    'a %s without @Roles needs moderator',
    (method) => {
      expect(requiredRole(method, undefined)).toBe(R.Moderator);
    },
  );

  it.each([
    ['GET', R.SuperAdmin],
    ['POST', R.SuperAdmin],
    ['POST', R.Support],
  ])('an explicit @Roles wins (%s, %s)', (method, declared) => {
    expect(requiredRole(method, declared)).toBe(declared);
  });
});
