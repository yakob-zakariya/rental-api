import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { normaliseEthiopianMobile } from '../../common/phone/ethiopian-phone.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { SmsSender } from '../sms/sms-sender.js';
import { User } from '../users/user.entity.js';
import { generateOtpCode, hashOtpCode, otpCodeMatches } from './otp-crypto.js';
import { otpSmsText } from './otp-message.js';

/** Rule A2: wrong attempts allowed per code. */
export const OTP_MAX_ATTEMPTS = 5;
/** Rule A3: at most this many codes per phone per window. */
export const OTP_MAX_REQUESTS_PER_WINDOW = 3;
export const OTP_REQUEST_WINDOW_MINUTES = 10;

type VerifyOutcome =
  | { kind: 'ok'; user: User }
  | { kind: 'invalid'; attemptsRemaining?: number }
  | { kind: 'expired' }
  | { kind: 'attempts_exceeded' };

/**
 * Phone OTP (spec section 3, rules A1–A4, A9). Times come from the database clock, and
 * clock_timestamp() rather than now(), so ordering follows the per-phone lock, not when each
 * transaction happened to start.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sms: SmsSender,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secret = config.get('OTP_HASH_SECRET', { infer: true });
    this.ttlSeconds = config.get('OTP_TTL_SECONDS', { infer: true });
  }

  /**
   * Creates and sends a code. Responds the same whether or not the phone has an account.
   * Errors: INVALID_PHONE (400), OTP_RATE_LIMITED (429), SMS_SEND_FAILED (503).
   */
  async request(rawPhone: string): Promise<{ expiresInSeconds: number }> {
    const phone = this.normalise(rawPhone);
    if (!phone) throw new BadRequestException({ code: 'INVALID_PHONE' });

    const code = generateOtpCode();
    await this.dataSource.transaction(async (manager) => {
      await this.lockPhone(manager, phone);

      // Rule A3, counted from the table so it survives restarts and spans instances.
      const [recent] = await manager.query<
        { count: number; retry_after: number | null }[]
      >(
        `SELECT count(*)::int AS count,
                ceil(extract(epoch FROM min(created_at)
                  + make_interval(mins => $2) - clock_timestamp()))::int AS retry_after
         FROM otp_codes
         WHERE phone = $1 AND created_at > clock_timestamp() - make_interval(mins => $2)`,
        [phone, OTP_REQUEST_WINDOW_MINUTES],
      );
      if (recent.count >= OTP_MAX_REQUESTS_PER_WINDOW) {
        throw new HttpException(
          {
            code: 'OTP_RATE_LIMITED',
            retryAfterSeconds: Math.max(1, recent.retry_after ?? 1),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Rule A4: a new code invalidates every older unconsumed one.
      await manager.query(
        `UPDATE otp_codes SET expires_at = clock_timestamp()
         WHERE phone = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
        [phone],
      );

      // Rules A1 + A9.
      await manager.query(
        `INSERT INTO otp_codes (phone, code_hash, expires_at, created_at)
         VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3), clock_timestamp())`,
        [phone, hashOtpCode(this.secret, phone, code), this.ttlSeconds],
      );
    });

    // Sent after commit. A failed send keeps the row, so it still counts toward rule A3.
    try {
      await this.sms.send(phone, otpSmsText(code, this.ttlSeconds));
    } catch (error) {
      this.logger.error(`OTP SMS failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException({ code: 'SMS_SEND_FAILED' });
    }

    return { expiresInSeconds: this.ttlSeconds };
  }

  /**
   * Checks the phone's latest code; on success consumes it and returns the user, creating them
   * on first sign-in. Errors (400): OTP_INVALID (with attemptsRemaining after a wrong code),
   * OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED. Account status (rule A6) is checked by the caller.
   */
  async verify(rawPhone: string, code: string): Promise<User> {
    const phone = this.normalise(rawPhone);
    if (!phone) throw new BadRequestException({ code: 'OTP_INVALID' });

    // Decided inside the transaction, thrown after it commits, so a wrong guess's attempt
    // count is saved rather than rolled back with the error.
    const outcome = await this.dataSource.transaction((manager) =>
      this.checkLatestCode(manager, phone, code),
    );

    switch (outcome.kind) {
      case 'ok':
        return outcome.user;
      case 'invalid':
        throw new BadRequestException({
          code: 'OTP_INVALID',
          ...(outcome.attemptsRemaining !== undefined && {
            attemptsRemaining: outcome.attemptsRemaining,
          }),
        });
      case 'expired':
        throw new BadRequestException({ code: 'OTP_EXPIRED' });
      case 'attempts_exceeded':
        throw new BadRequestException({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    }
  }

  private async checkLatestCode(
    manager: EntityManager,
    phone: string,
    code: string,
  ): Promise<VerifyOutcome> {
    // Only the latest code can ever succeed (rule A4). FOR UPDATE serialises concurrent
    // guesses (rule A2) and prevents a code being consumed twice.
    const [otp] = await manager.query<
      {
        id: string;
        code_hash: string;
        attempts: number;
        usable: boolean;
      }[]
    >(
      `SELECT id, code_hash, attempts,
              (consumed_at IS NULL AND expires_at > clock_timestamp()) AS usable
       FROM otp_codes
       WHERE phone = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [phone],
    );

    if (!otp) return { kind: 'invalid' };
    if (!otp.usable) return { kind: 'expired' };
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return { kind: 'attempts_exceeded' };

    if (!otpCodeMatches(this.secret, phone, code, otp.code_hash)) {
      const attempts = otp.attempts + 1;
      await manager.query(`UPDATE otp_codes SET attempts = $2 WHERE id = $1`, [
        otp.id,
        attempts,
      ]);
      return attempts >= OTP_MAX_ATTEMPTS
        ? { kind: 'attempts_exceeded' }
        : { kind: 'invalid', attemptsRemaining: OTP_MAX_ATTEMPTS - attempts };
    }

    await manager.query(
      `UPDATE otp_codes SET consumed_at = clock_timestamp() WHERE id = $1`,
      [otp.id],
    );
    return { kind: 'ok', user: await this.findOrCreateUser(manager, phone) };
  }

  private async findOrCreateUser(
    manager: EntityManager,
    phone: string,
  ): Promise<User> {
    const users = manager.getRepository(User);
    // ON CONFLICT DO NOTHING: safe if the same phone is created concurrently.
    await users
      .createQueryBuilder()
      .insert()
      .values({ phone })
      .orIgnore()
      .execute();
    return users.findOneByOrFail({ phone });
  }

  private lockPhone(manager: EntityManager, phone: string): Promise<unknown> {
    // Serialises requests for one phone, so concurrent requests can't slip past rule A3.
    return manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`otp:${phone}`],
    );
  }

  private normalise(rawPhone: string): string | null {
    return typeof rawPhone === 'string'
      ? normaliseEthiopianMobile(rawPhone)
      : null;
  }
}
