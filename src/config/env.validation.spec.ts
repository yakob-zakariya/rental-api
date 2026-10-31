import {
  DiditEnvironment,
  NodeEnv,
  SmsProvider,
  validateEnv,
} from './env.validation.js';

const secret = (name: string) => `${name}-0123456789abcdef0123456789abcdef`;

const validEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://rental:rental@localhost:5432/rental',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: secret('access'),
  JWT_REFRESH_SECRET: secret('refresh'),
  ADMIN_JWT_SECRET: secret('admin'),
  ID_HASH_PEPPER: secret('pepper'),
  OTP_HASH_SECRET: secret('otp'),
  DIDIT_API_KEY: 'didit-api-key',
  DIDIT_WEBHOOK_SECRET: 'didit-webhook-secret',
  DIDIT_WORKFLOW_ID: 'didit-workflow-id',
  APP_VERIFICATION_CALLBACK_URL: 'https://app.example.et/verification/done',
});

const REQUIRED = Object.keys(validEnv());

const errorOf = (raw: Record<string, unknown>): string => {
  try {
    validateEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected validateEnv to throw');
};

describe('validateEnv', () => {
  it('accepts a valid env and applies the spec defaults', () => {
    const env = validateEnv(validEnv());

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.JWT_REFRESH_TTL).toBe('30d');
    expect(env.ADMIN_JWT_TTL).toBe('8h');
    expect(env.OTP_TTL_SECONDS).toBe(300);
    expect(env.OTP_REQUEST_IP_LIMIT_PER_HOUR).toBe(30);
    expect(env.REFRESH_REUSE_GRACE_SECONDS).toBe(60);
    expect(env.SMS_PROVIDER).toBe(SmsProvider.Console);
    expect(env.DIDIT_BASE_URL).toBe('https://verification.didit.me');
  });

  it('converts numbers and booleans from strings', () => {
    const env = validateEnv({
      ...validEnv(),
      PORT: '8080',
      OTP_TTL_SECONDS: '120',
      SWAGGER_ENABLED: 'true',
    });

    expect(env.PORT).toBe(8080);
    expect(env.OTP_TTL_SECONDS).toBe(120);
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it.each(REQUIRED)('refuses to start without %s', (key) => {
    const raw = validEnv();
    delete raw[key];

    expect(errorOf(raw)).toContain(`${key} is required`);
  });

  it('treats an empty value as missing', () => {
    expect(errorOf({ ...validEnv(), ID_HASH_PEPPER: '' })).toContain(
      'ID_HASH_PEPPER is required',
    );
  });

  it('lists every problem at once', () => {
    const raw = validEnv();
    delete raw.DATABASE_URL;
    delete raw.OTP_HASH_SECRET;

    const message = errorOf(raw);
    expect(message).toContain('DATABASE_URL is required');
    expect(message).toContain('OTP_HASH_SECRET is required');
  });

  it.each([
    ['NODE_ENV', 'staging', 'must be one of development, test, production'],
    ['PORT', 'abc', 'must be an integer'],
    ['PORT', '70000', 'must be between 1 and 65535'],
    ['DATABASE_URL', 'mysql://localhost/rental', 'must be a postgres:// URL'],
    ['REDIS_URL', 'localhost:6379', 'must be a redis:// URL'],
    ['SWAGGER_ENABLED', 'yes', 'must be true or false'],
    ['JWT_ACCESS_TTL', '15 minutes', 'must be a duration'],
    ['ADMIN_JWT_TTL', '8', 'must be a duration'],
    ['OTP_TTL_SECONDS', '0', 'must be a positive number of seconds'],
    ['OTP_REQUEST_IP_LIMIT_PER_HOUR', '0', 'must be at least 1'],
    ['REFRESH_REUSE_GRACE_SECONDS', '-1', 'must be 0 or more seconds'],
    ['OTP_REQUEST_IP_LIMIT_PER_HOUR', 'many', 'must be an integer'],
    ['SMS_PROVIDER', 'twilio', 'must be one of console'],
    [
      'DIDIT_BASE_URL',
      'http://verification.didit.me',
      'must be an https:// URL',
    ],
    ['APP_VERIFICATION_CALLBACK_URL', 'not a url', 'must be an http(s):// URL'],
  ])('rejects %s=%s', (key, value, expected) => {
    expect(errorOf({ ...validEnv(), [key]: value })).toContain(
      `${key} ${expected}`,
    );
  });

  it.each([
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'ADMIN_JWT_SECRET',
    'ID_HASH_PEPPER',
    'OTP_HASH_SECRET',
  ])('requires %s to be at least 32 characters', (key) => {
    expect(errorOf({ ...validEnv(), [key]: 'x'.repeat(31) })).toContain(
      `${key} must be at least 32 characters`,
    );
    expect(() =>
      validateEnv({ ...validEnv(), [key]: 'x'.repeat(32) }),
    ).not.toThrow();
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
    'rejects ADMIN_JWT_SECRET equal to %s',
    (key) => {
      const raw = validEnv();
      raw.ADMIN_JWT_SECRET = raw[key];

      expect(errorOf(raw)).toContain('ADMIN_JWT_SECRET must differ');
    },
  );

  describe('DIDIT_ENVIRONMENT', () => {
    it.each(['development', 'test'])('defaults to sandbox in %s', (nodeEnv) => {
      expect(
        validateEnv({ ...validEnv(), NODE_ENV: nodeEnv }).DIDIT_ENVIRONMENT,
      ).toBe(DiditEnvironment.Sandbox);
    });

    it('is required in production', () => {
      expect(errorOf({ ...validEnv(), NODE_ENV: 'production' })).toContain(
        'DIDIT_ENVIRONMENT is required in production',
      );
    });

    it.each(['sandbox', 'live'])('accepts %s', (value) => {
      expect(
        validateEnv({ ...validEnv(), DIDIT_ENVIRONMENT: value })
          .DIDIT_ENVIRONMENT,
      ).toBe(value);
    });

    it('rejects anything else', () => {
      expect(
        errorOf({ ...validEnv(), DIDIT_ENVIRONMENT: 'production' }),
      ).toContain('DIDIT_ENVIRONMENT must be one of sandbox, live');
    });
  });

  describe('SMS_PROVIDER=console', () => {
    it('is rejected in production', () => {
      expect(errorOf({ ...validEnv(), NODE_ENV: 'production' })).toContain(
        "SMS_PROVIDER=console logs OTP codes and can't be used in production",
      );
    });

    it.each(['development', 'test'])('is allowed in %s', (nodeEnv) => {
      const env = validateEnv({ ...validEnv(), NODE_ENV: nodeEnv });

      expect(env.SMS_PROVIDER).toBe(SmsProvider.Console);
    });
  });

  describe('placeholder values', () => {
    const withPlaceholders = (nodeEnv: string) => ({
      ...validEnv(),
      NODE_ENV: nodeEnv,
      JWT_ACCESS_SECRET: 'change-me-jwt-access-secret-0123456789',
      DIDIT_API_KEY: 'change-me-didit-api-key',
      APP_VERIFICATION_CALLBACK_URL: 'https://example.com/change-me',
    });

    it('rejects them in production', () => {
      const message = errorOf(withPlaceholders('production'));

      expect(message).toContain(
        'JWT_ACCESS_SECRET still has a placeholder value',
      );
      expect(message).toContain('DIDIT_API_KEY still has a placeholder value');
      expect(message).toContain(
        'APP_VERIFICATION_CALLBACK_URL still has a placeholder value',
      );
    });

    it.each(['development', 'test'])('allows them in %s', (nodeEnv) => {
      expect(() => validateEnv(withPlaceholders(nodeEnv))).not.toThrow();
    });
  });

  it('never includes values in the error message', () => {
    const raw = {
      ...validEnv(),
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'too-short-secret',
      DIDIT_API_KEY: 'change-me-leaky-didit-key',
      DATABASE_URL: 'mysql://user:hunter2@db/rental',
    };

    const message = errorOf(raw);
    expect(message).not.toContain('too-short-secret');
    expect(message).not.toContain('leaky-didit-key');
    expect(message).not.toContain('hunter2');
  });

  it('ignores unrelated variables', () => {
    expect(() =>
      validateEnv({ ...validEnv(), PATH: '/usr/bin', HOME: '/root' }),
    ).not.toThrow();
  });
});
