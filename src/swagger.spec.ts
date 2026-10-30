import { NodeEnv } from './config/env.validation.js';
import { isSwaggerEnabled } from './swagger.js';

describe('isSwaggerEnabled', () => {
  it.each([
    [NodeEnv.Development, false, true],
    [NodeEnv.Development, true, true],
    [NodeEnv.Test, false, true],
    [NodeEnv.Test, true, true],
    [NodeEnv.Production, false, false],
    [NodeEnv.Production, true, true],
  ])(
    'NODE_ENV=%s, SWAGGER_ENABLED=%s → %s',
    (NODE_ENV, SWAGGER_ENABLED, expected) => {
      expect(isSwaggerEnabled({ NODE_ENV, SWAGGER_ENABLED })).toBe(expected);
    },
  );
});
