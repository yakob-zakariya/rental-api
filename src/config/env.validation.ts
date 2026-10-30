import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
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

  if (env.NODE_ENV === NodeEnv.Production) {
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
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }

  return env;
}
