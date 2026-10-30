/**
 * The complete environment for e2e tests, applied by vitest.config.e2e.ts. AppModule ignores .env
 * when NODE_ENV=test, so every variable the app reads must be here. Dummy values only.
 */
export const TEST_ENV = {
  NODE_ENV: 'test',
  PORT: '3000', // unused: tests call app.init(), never listen()
  // Must end in _test: global-setup.ts drops and recreates this database on every run.
  DATABASE_URL: 'postgres://rental:rental@localhost:5432/rental_test',
  // Redis database 1 is for tests; global-setup.ts flushes it on every run.
  REDIS_URL: 'redis://localhost:6379/1',
  SWAGGER_ENABLED: 'false',

  JWT_ACCESS_SECRET: 'test-jwt-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  ADMIN_JWT_SECRET: 'test-admin-jwt-secret-0123456789abcdef',
  ADMIN_JWT_TTL: '8h',

  ID_HASH_PEPPER: 'test-id-hash-pepper-0123456789abcdef',

  OTP_TTL_SECONDS: '300',
  OTP_HASH_SECRET: 'test-otp-hash-secret-0123456789abcdef',
  SMS_PROVIDER: 'console',

  DIDIT_API_KEY: 'test-didit-api-key',
  DIDIT_WEBHOOK_SECRET: 'test-didit-webhook-secret',
  DIDIT_WORKFLOW_ID: 'test-didit-workflow-id',
  DIDIT_BASE_URL: 'https://verification.didit.me',
  APP_VERIFICATION_CALLBACK_URL: 'https://app.example.test/verification/done',
} as const satisfies Record<string, string>;
