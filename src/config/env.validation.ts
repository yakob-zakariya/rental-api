import { plainToInstance, Transform } from 'class-transformer';
import { CLOCK_TIME_PATTERN } from '../common/dates.js';
import { durationToSeconds } from '../common/duration.js';
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum SmsProvider {
  Console = 'console',
}

/** Who sends push notifications (spec N1): `console` only logs; `fcm` is Firebase Cloud Messaging. */
export enum PushProvider {
  Console = 'console',
  Fcm = 'fcm',
}

/** Which Didit environment's webhook events we accept (spec §4 flow step 3). */
export enum DiditEnvironment {
  Sandbox = 'sandbox',
  Live = 'live',
}

const SECRET_MIN_LENGTH = 32;
// Values in .env.example contain this marker; they must never reach production.
const PLACEHOLDER_MARKER = 'change-me';
// Same format @nestjs/jwt accepts for expiresIn, e.g. 15m, 30d, 8h.
const DURATION_PATTERN = /^\d+[smhd]$/;

const required = { message: '$property is required' };
const secret = {
  message: `$property must be at least ${SECRET_MIN_LENGTH} characters`,
};
const duration = {
  message: '$property must be a duration like 15m, 30d or 8h',
};

const toNumber = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? Number(value) : value;
const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/**
 * Every environment variable the app reads. Fields with an initialiser are optional and default
 * to the spec's value; the rest are required. Transforms are explicit (no reflection metadata) so
 * this behaves the same under Nest, the TypeORM CLI and Vitest. With `stopAtFirstError`,
 * class-validator runs decorators bottom-up, so the type check sits closest to the property.
 */
export class EnvironmentVariables {
  // --- App ---
  @IsDefined(required)
  @IsEnum(NodeEnv, {
    message: '$property must be one of development, test, production',
  })
  NODE_ENV: NodeEnv;

  @Transform(toNumber)
  @Min(1, { message: '$property must be between 1 and 65535' })
  @Max(65535, { message: '$property must be between 1 and 65535' })
  @IsInt({ message: '$property must be an integer' })
  PORT: number = 3000;

  @IsDefined(required)
  @IsUrl(
    {
      protocols: ['postgres', 'postgresql'],
      require_protocol: true,
      require_tld: false,
    },
    { message: '$property must be a postgres:// URL' },
  )
  DATABASE_URL: string;

  @IsDefined(required)
  @IsUrl(
    {
      protocols: ['redis', 'rediss'],
      require_protocol: true,
      require_tld: false,
    },
    { message: '$property must be a redis:// URL' },
  )
  REDIS_URL: string;

  @Transform(toBoolean)
  @IsBoolean({ message: '$property must be true or false' })
  SWAGGER_ENABLED: boolean = false;

  // Scheduled jobs (verification polling). Off in tests, which call the jobs directly.
  @Transform(toBoolean)
  @IsBoolean({ message: '$property must be true or false' })
  JOBS_ENABLED: boolean = true;

  // --- Auth ---
  @IsDefined(required)
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, secret)
  JWT_ACCESS_SECRET: string;

  @IsDefined(required)
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, secret)
  JWT_REFRESH_SECRET: string;

  @Matches(DURATION_PATTERN, duration)
  JWT_ACCESS_TTL: string = '15m';

  @Matches(DURATION_PATTERN, duration)
  JWT_REFRESH_TTL: string = '30d';

  @IsDefined(required)
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, secret)
  ADMIN_JWT_SECRET: string;

  // Rule A5 grace: a rotated refresh token retried within this many seconds, whose replacement
  // was never used, is treated as a lost response rather than theft. 0 disables the grace.
  @Transform(toNumber)
  @Min(0, { message: '$property must be 0 or more seconds' })
  @IsInt({ message: '$property must be an integer' })
  REFRESH_REUSE_GRACE_SECONDS: number = 60;

  @Matches(DURATION_PATTERN, duration)
  ADMIN_JWT_TTL: string = '8h';

  // --- Identity hashing ---
  @IsDefined(required)
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, secret)
  ID_HASH_PEPPER: string;

  // --- OTP / SMS ---
  @Transform(toNumber)
  @Min(1, { message: '$property must be a positive number of seconds' })
  @IsInt({ message: '$property must be an integer' })
  OTP_TTL_SECONDS: number = 300;

  // Rule A8: per-IP limit on POST /auth/otp/request. Loose on purpose (shared mobile IPs).
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  OTP_REQUEST_IP_LIMIT_PER_HOUR: number = 30;

  // Per-IP limit on POST /admin/auth/login (brute-force protection), per 15 minutes.
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  ADMIN_LOGIN_IP_LIMIT_PER_15_MIN: number = 10;

  @IsDefined(required)
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, secret)
  OTP_HASH_SECRET: string;

  @IsEnum(SmsProvider, { message: '$property must be one of console' })
  SMS_PROVIDER: SmsProvider = SmsProvider.Console;

  // --- Didit ---
  @IsDefined(required)
  @IsString()
  DIDIT_API_KEY: string;

  @IsDefined(required)
  @IsString()
  DIDIT_WEBHOOK_SECRET: string;

  @IsDefined(required)
  @IsString()
  DIDIT_WORKFLOW_ID: string;

  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { message: '$property must be an https:// URL' },
  )
  DIDIT_BASE_URL: string = 'https://verification.didit.me';

  @IsDefined(required)
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false,
    },
    { message: '$property must be an http(s):// URL' },
  )
  APP_VERIFICATION_CALLBACK_URL: string;

  // No default here: sandbox is filled in by validateEnv outside production, and production
  // must set it explicitly so it can never silently accept sandbox events.
  @IsOptional()
  @IsEnum(DiditEnvironment, {
    message: '$property must be one of sandbox, live',
  })
  DIDIT_ENVIRONMENT: DiditEnvironment;

  // --- Listings ---
  // Drafts one user may hold at once (spec L1, decided 2026-11-23).
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  MAX_DRAFT_LISTINGS: number = 10;

  // Active listings (pending_review, live, stale) one user may hold: the hard cap (spec L2, P2-1).
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  LISTING_MAX_ACTIVE_PER_USER: number = 10;

  // --- Photo storage (spec P1, P5; T3.1) ---
  // S3-compatible: SeaweedFS in development (docker-compose.yml), R2 or similar in production.
  @IsDefined(required)
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false,
    },
    { message: '$property must be an http(s):// URL' },
  )
  S3_ENDPOINT: string;

  // R2 expects "auto"; SeaweedFS ignores it.
  @IsString()
  S3_REGION: string = 'auto';

  @IsDefined(required)
  @IsString()
  S3_ACCESS_KEY_ID: string;

  @IsDefined(required)
  @IsString()
  S3_SECRET_ACCESS_KEY: string;

  // Every photo, served to the lister and staff through signed links (P5).
  @IsDefined(required)
  @IsString()
  S3_PRIVATE_BUCKET: string;

  // Copies of live listings' photos only, readable by anyone (P5). R2 can make only a whole bucket
  // public, so this is a second bucket (decided 2026-11-24).
  @IsDefined(required)
  @IsString()
  S3_PUBLIC_BUCKET: string;

  // Where the public bucket is served from: its custom domain in production.
  @IsDefined(required)
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false,
    },
    { message: '$property must be an http(s):// URL' },
  )
  S3_PUBLIC_BASE_URL: string;

  // SeaweedFS needs path-style URLs; R2 accepts them.
  @Transform(toBoolean)
  @IsBoolean({ message: '$property must be true or false' })
  S3_FORCE_PATH_STYLE: boolean = true;

  // How long a private photo's signed link works (P5: short-lived; 15 minutes, decided
  // 2026-11-24). S3 signatures allow at most 7 days.
  @Transform(toNumber)
  @Min(1, { message: '$property must be between 1 and 604800' })
  @Max(604800, { message: '$property must be between 1 and 604800' })
  @IsInt({ message: '$property must be an integer' })
  PHOTO_SIGNED_URL_TTL_SECONDS: number = 900;

  // Cache-Control max-age on public photos. Moderate on purpose (1 day, decided 2026-11-24): a
  // photo stays reachable from phone and CDN caches this long after it's unpublished, e.g. after
  // a staff takedown (which also purges the CDN cache, T4.2).
  @Transform(toNumber)
  @Min(0, { message: '$property must be 0 or more seconds' })
  @IsInt({ message: '$property must be an integer' })
  PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS: number = 86400;

  // --- Photo upload (spec P1, P2; T3.2) ---
  // Per uploaded file, before re-encoding (P1). Larger: 413, refused while still uploading.
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  PHOTO_MAX_BYTES: number = 10485760;

  // Longest side of the stored photo, in pixels, after re-encoding (P2). Never enlarged.
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  PHOTO_MAX_DIMENSION: number = 2048;

  // Width × height of the uploaded image (decided 2026-11-24: 50 MP). A small file can expand to a
  // huge image (a "decompression bomb"); 200 MP would need about 600 MB to decode.
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  PHOTO_MAX_INPUT_PIXELS: number = 50_000_000;

  // --- Browse (spec G5; T5.1) ---
  // The largest "near me" radius a search may ask for, in km.
  @Transform(toNumber)
  @Min(1, { message: '$property must be at least 1' })
  @IsInt({ message: '$property must be an integer' })
  SEARCH_MAX_RADIUS_KM: number = 20;

  // --- Freshness (spec F1–F6; T6.3) ---
  /** F1: a live listing is asked "still available?" this long after publishing or confirming. */
  @Matches(DURATION_PATTERN, duration)
  LISTING_CHECK_INTERVAL: string = '7d';

  /** F3: no answer this long after the check was sent → stale. */
  @Matches(DURATION_PATTERN, duration)
  LISTING_CHECK_ANSWER_WINDOW: string = '48h';

  /** F5: stale this long → expired. */
  @Matches(DURATION_PATTERN, duration)
  LISTING_STALE_TO_EXPIRED: string = '30d';

  // --- Push (spec N1; T6.1) ---
  @IsEnum(PushProvider, { message: '$property must be one of console, fcm' })
  PUSH_PROVIDER: PushProvider = PushProvider.Console;

  /**
   * The Firebase service-account JSON (needed with PUSH_PROVIDER=fcm). Its contents are checked
   * at startup by FcmPushSender. A full admin key for the Firebase project: never committed.
   */
  @IsOptional()
  @IsString()
  FCM_SERVICE_ACCOUNT_FILE?: string;

  /**
   * Quiet hours, Africa/Addis_Ababa, 'HH:MM' (decided 2026-11-24): weekly checks and stale
   * notices wait until PUSH_QUIET_END. From START (included) to END (excluded); equal = none.
   */
  @Matches(CLOCK_TIME_PATTERN, {
    message: '$property must be a time like 20:00',
  })
  PUSH_QUIET_START: string = '20:00';

  @Matches(CLOCK_TIME_PATTERN, {
    message: '$property must be a time like 08:00',
  })
  PUSH_QUIET_END: string = '08:00';
}

// Variables whose .env.example value is a placeholder that production must replace.
const PLACEHOLDER_CHECKED = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ADMIN_JWT_SECRET',
  'ID_HASH_PEPPER',
  'OTP_HASH_SECRET',
  'DIDIT_API_KEY',
  'DIDIT_WEBHOOK_SECRET',
  'DIDIT_WORKFLOW_ID',
  'APP_VERIFICATION_CALLBACK_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const satisfies readonly (keyof EnvironmentVariables)[];

/**
 * Validates raw env (process.env plus .env) and returns typed config. Throws one error listing
 * every problem. Messages name variables only — never their values, which may be secrets.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  // `FOO=` in .env arrives as ''; treat it as unset so defaults and "is required" apply.
  const present = Object.fromEntries(
    Object.entries(raw).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  );

  const env = plainToInstance(EnvironmentVariables, present, {
    exposeDefaultValues: true,
  });

  const problems = validateSync(env, { stopAtFirstError: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );

  // Hard rule 8: staff tokens must never verify as app-user tokens, or vice versa.
  if (
    env.ADMIN_JWT_SECRET &&
    (env.ADMIN_JWT_SECRET === env.JWT_ACCESS_SECRET ||
      env.ADMIN_JWT_SECRET === env.JWT_REFRESH_SECRET)
  ) {
    problems.push(
      'ADMIN_JWT_SECRET must differ from JWT_ACCESS_SECRET and JWT_REFRESH_SECRET',
    );
  }

  // P5: public and private photos must never share a bucket.
  if (env.S3_PRIVATE_BUCKET && env.S3_PRIVATE_BUCKET === env.S3_PUBLIC_BUCKET) {
    problems.push('S3_PUBLIC_BUCKET must differ from S3_PRIVATE_BUCKET');
  }

  // F3: a check must be answerable before the next one is due.
  if (
    DURATION_PATTERN.test(env.LISTING_CHECK_INTERVAL) &&
    DURATION_PATTERN.test(env.LISTING_CHECK_ANSWER_WINDOW) &&
    durationToSeconds(env.LISTING_CHECK_ANSWER_WINDOW) >=
      durationToSeconds(env.LISTING_CHECK_INTERVAL)
  ) {
    problems.push(
      'LISTING_CHECK_ANSWER_WINDOW must be shorter than LISTING_CHECK_INTERVAL',
    );
  }

  if (
    env.PUSH_PROVIDER === PushProvider.Fcm &&
    !env.FCM_SERVICE_ACCOUNT_FILE?.trim()
  ) {
    problems.push(
      'FCM_SERVICE_ACCOUNT_FILE is required when PUSH_PROVIDER=fcm',
    );
  }

  if (env.NODE_ENV === NodeEnv.Production) {
    for (const key of ['S3_ENDPOINT', 'S3_PUBLIC_BASE_URL'] as const) {
      if (env[key] && !env[key].startsWith('https://')) {
        problems.push(`${key} must be an https:// URL in production`);
      }
    }
    for (const key of PLACEHOLDER_CHECKED) {
      if (env[key]?.toLowerCase().includes(PLACEHOLDER_MARKER)) {
        problems.push(`${key} still has a placeholder value from .env.example`);
      }
    }
    // The console sender writes OTP codes to the logs: anyone reading them could sign in as anyone.
    if (env.SMS_PROVIDER === SmsProvider.Console) {
      problems.push(
        "SMS_PROVIDER=console logs OTP codes and can't be used in production",
      );
    }
    // The console sender only logs: nobody would receive a weekly check or a decision.
    if (env.PUSH_PROVIDER === PushProvider.Console) {
      problems.push(
        "PUSH_PROVIDER=console sends nothing and can't be used in production",
      );
    }
  }

  if (env.DIDIT_ENVIRONMENT === undefined) {
    if (env.NODE_ENV === NodeEnv.Production) {
      problems.push(
        'DIDIT_ENVIRONMENT is required in production (sandbox or live)',
      );
    } else {
      env.DIDIT_ENVIRONMENT = DiditEnvironment.Sandbox;
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }

  return env;
}
