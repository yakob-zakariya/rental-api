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
  JOBS_ENABLED: 'false', // e2e tests call the jobs directly

  JWT_ACCESS_SECRET: 'test-jwt-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  ADMIN_JWT_SECRET: 'test-admin-jwt-secret-0123456789abcdef',
  ADMIN_JWT_TTL: '8h',
  REFRESH_REUSE_GRACE_SECONDS: '60',

  ID_HASH_PEPPER: 'test-id-hash-pepper-0123456789abcdef',

  OTP_TTL_SECONDS: '300',
  // High so e2e files sharing one app don't trip it; the A8 test lowers it for its own app.
  OTP_REQUEST_IP_LIMIT_PER_HOUR: '1000',
  // High for the same reason; the admin login limit test lowers it for its own app.
  ADMIN_LOGIN_IP_LIMIT_PER_15_MIN: '1000',
  OTP_HASH_SECRET: 'test-otp-hash-secret-0123456789abcdef',
  SMS_PROVIDER: 'console',

  DIDIT_API_KEY: 'test-didit-api-key',
  DIDIT_WEBHOOK_SECRET: 'test-didit-webhook-secret',
  DIDIT_WORKFLOW_ID: 'test-didit-workflow-id',
  DIDIT_BASE_URL: 'https://verification.didit.me',
  DIDIT_ENVIRONMENT: 'sandbox',
  APP_VERIFICATION_CALLBACK_URL: 'https://app.example.test/verification/done',

  MAX_DRAFT_LISTINGS: '10',
  LISTING_MAX_ACTIVE_PER_USER: '10',

  // The local SeaweedFS (docker-compose.yml); its own test buckets, which global-setup.ts creates
  // and empties on every run. Names must contain "test".
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'change-me-dev-access-key',
  S3_SECRET_ACCESS_KEY: 'change-me-dev-secret-key-local-only',
  S3_PRIVATE_BUCKET: 'rental-test-photos-private',
  S3_PUBLIC_BUCKET: 'rental-test-photos-public',
  S3_PUBLIC_BASE_URL: 'http://localhost:8333/rental-test-photos-public',
  S3_FORCE_PATH_STYLE: 'true',
  PHOTO_SIGNED_URL_TTL_SECONDS: '900',
  PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS: '86400',
  PHOTO_MAX_BYTES: '10485760',
  PHOTO_MAX_DIMENSION: '2048',
  PHOTO_MAX_INPUT_PIXELS: '50000000',
} as const satisfies Record<string, string>;
