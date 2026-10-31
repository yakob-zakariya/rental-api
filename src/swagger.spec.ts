import { NodeEnv } from './config/env.validation.js';
import { docsBasicAuth, isSwaggerEnabled, parseBasicAuth } from './swagger.js';

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

describe('parseBasicAuth', () => {
  const basic = (value: string) =>
    `Basic ${Buffer.from(value).toString('base64')}`;

  it('reads email and password (the password may contain colons)', () => {
    expect(parseBasicAuth(basic('staff@example.com:pa:ss:word'))).toEqual({
      email: 'staff@example.com',
      password: 'pa:ss:word',
    });
  });

  it.each([
    ['no header', undefined],
    ['a Bearer token', 'Bearer abc'],
    ['no colon', basic('staff@example.com')],
    ['an empty email', basic(':password')],
    ['not base64', 'Basic !!!'],
  ])('rejects %s', (_label, header) => {
    expect(parseBasicAuth(header)).toBeNull();
  });
});

describe('docsBasicAuth', () => {
  const run = async (header: string | undefined, valid: boolean) => {
    const check = vi.fn().mockResolvedValue(valid);
    const next = vi.fn();
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await docsBasicAuth(check)(
      { headers: { authorization: header } } as never,
      res as never,
      next,
    );
    return { check, next, res };
  };
  const header = `Basic ${Buffer.from('staff@example.com:secret-password').toString('base64')}`;

  it('lets valid staff credentials through', async () => {
    const { check, next, res } = await run(header, true);

    expect(check).toHaveBeenCalledWith('staff@example.com', 'secret-password');
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong credentials', header, false],
    ['no credentials', undefined, true],
  ])(
    'answers %s with 401 and a Basic challenge',
    async (_label, value, valid) => {
      const { next, res } = await run(value, valid);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Basic realm="rental-api docs", charset="UTF-8"',
      );
    },
  );
});
