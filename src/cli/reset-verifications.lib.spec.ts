import {
  ResetRefusedError,
  assertResetAllowed,
  isConfirmed,
} from './reset-verifications.lib.js';

describe('dev:reset-verifications guards', () => {
  it.each([undefined, '', 'test', 'production', 'Development', 'dev'])(
    'refuses NODE_ENV=%s',
    (nodeEnv) => {
      expect(() =>
        assertResetAllowed({ nodeEnv, databaseName: 'rental' }),
      ).toThrow(ResetRefusedError);
    },
  );

  it.each(['rental_prod', 'RENTAL_PROD', 'app_prod'])(
    'refuses the database %s',
    (databaseName) => {
      expect(() =>
        assertResetAllowed({ nodeEnv: 'development', databaseName }),
      ).toThrow(/production/);
    },
  );

  it.each(['rental', 'rental_dev', 'production_copy'])(
    'allows development with the database %s',
    (databaseName) => {
      expect(() =>
        assertResetAllowed({ nodeEnv: 'development', databaseName }),
      ).not.toThrow();
    },
  );

  it.each([
    ['reset', true],
    ['  reset\n', true],
    ['RESET', false],
    ['y', false],
    ['yes', false],
    ['', false],
    ['reset please', false],
  ])('confirmation %j → %s', (answer, expected) => {
    expect(isConfirmed(answer)).toBe(expected);
  });
});
