import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminActionType,
  AuditTargetType,
} from '../../admin/audit/audit.enums.js';
import { AuditService } from '../../admin/audit/audit.service.js';
import {
  cursorTimestampSql,
  decodeCursor,
  encodeCursor,
} from '../../admin/pagination.js';
import {
  DECISION_TIME_ZONE,
  isIsoDate,
  isUnder18,
  todayIn,
} from '../decision/age.js';
import { DecisionService } from '../decision/decision.service.js';
import {
  type IdentityIdentifier,
  IdentityHasher,
  normaliseIdNumber,
} from '../identity-hasher.js';
import { IdentityKind, VerificationOutcome } from '../verification.enums.js';
import type {
  ApproveVerificationDto,
  DeclineVerificationDto,
  QueueItemDto,
  QueuePageDto,
  VerificationDetailDto,
  VerificationQueueQuery,
} from './verification-review.dto.js';
import { DEFAULT_QUEUE_PAGE } from './verification-review.dto.js';

interface AttemptRow {
  id: string;
  user_id: string;
  outcome: VerificationOutcome;
  decided: boolean;
  verified_name: string | null;
  date_of_birth: string | null;
  document_type: string | null;
}

const DEFAULT_QUEUE_STATUSES = [
  VerificationOutcome.ManualReview,
  VerificationOutcome.Blocked,
];
const APPROVABLE = [
  VerificationOutcome.ManualReview,
  VerificationOutcome.Blocked,
];
const FIN_OR_FAN = {
  [IdentityKind.FaydaFin]: 12,
  [IdentityKind.FaydaFan]: 16,
} as const;
const PASSPORT_NUMBER = /^[A-Z0-9]{5,20}$/;
const ALPHA_3 = /^[A-Z]{3}$/;
const DOCUMENT_TYPE_LABEL: Record<IdentityKind, string> = {
  [IdentityKind.FaydaFin]: 'Identity Card',
  [IdentityKind.FaydaFan]: 'Identity Card',
  [IdentityKind.Passport]: 'Passport',
};

const conflict = (code: string) => new ConflictException({ code });
const attemptNotFound = () =>
  new NotFoundException({ code: 'ATTEMPT_NOT_FOUND' });
// Never says what was wrong with the number, and never echoes it (hard rule 1).
const invalidIdNumber = () =>
  new BadRequestException({ code: 'INVALID_ID_NUMBER' });

/** Staff review of verification attempts (spec §5, S4). Every change is audited (S1). */
@Injectable()
export class VerificationReviewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly decisions: DecisionService,
    private readonly hasher: IdentityHasher,
    private readonly audit: AuditService,
  ) {}

  /** GET /admin/verifications: oldest first, by default undecided manual_review + blocked. */
  async queue(query: VerificationQueueQuery): Promise<QueuePageDto> {
    const limit = query.limit ?? DEFAULT_QUEUE_PAGE;
    const params: unknown[] = [query.status ?? DEFAULT_QUEUE_STATUSES];
    const where = [`a.outcome = ANY($1::verification_outcome[])`];
    if (query.flagged !== undefined) {
      where.push(
        query.flagged ? 'a.flagged_at IS NOT NULL' : 'a.flagged_at IS NULL',
      );
    }
    if (!query.includeDecided) where.push('a.decided_by_admin_id IS NULL');
    if (query.after) {
      const cursor = decodeCursor(query.after);
      params.push(cursor.createdAt, cursor.id);
      where.push(
        `(a.created_at, a.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1);

    const rows = await this.dataSource.query<
      (QueueRow & { cursor_ts: string })[]
    >(
      `${QUEUE_SELECT}, ${cursorTimestampSql('a.created_at')} AS cursor_ts
       FROM identity_verifications a JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at, a.id
       LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toQueueItem),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.cursor_ts, last.id)
          : null,
    };
  }

  /** GET /admin/verifications/:attemptId: Didit's values next to the effective ones, plus history. */
  async detail(attemptId: string): Promise<VerificationDetailDto> {
    const [row] = await this.dataSource.query<
      (QueueRow & {
        provider_verified_name: string | null;
        provider_date_of_birth: string | null;
      })[]
    >(
      `${QUEUE_SELECT}, a.provider_verified_name, a.provider_date_of_birth::text
       FROM identity_verifications a JOIN users u ON u.id = a.user_id
       WHERE a.id = $1`,
      [attemptId],
    );
    if (!row) throw attemptNotFound();

    const identities = await this.dataSource.query<
      { kind: string; is_approved: boolean }[]
    >(
      `SELECT kind, is_approved FROM identity_hashes WHERE verification_id = $1 ORDER BY kind::text`,
      [attemptId],
    );
    const history = await this.dataSource.query<HistoryRow[]>(
      `SELECT id, outcome, provider_status, decline_reason, flag_reason,
              decided_by_admin_id IS NOT NULL AS decided, created_at, completed_at
       FROM identity_verifications WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [row.user_id],
    );
    return {
      ...toQueueItem(row),
      providerVerifiedName: row.provider_verified_name,
      providerDateOfBirth: row.provider_date_of_birth,
      identities: identities.map((i) => ({
        kind: i.kind,
        isApproved: i.is_approved,
      })),
      history: history.map((h) => ({
        attemptId: h.id,
        outcome: h.outcome,
        providerStatus: h.provider_status,
        declineReason: h.decline_reason,
        flagReason: h.flag_reason,
        decided: h.decided,
        createdAt: h.created_at.toISOString(),
        completedAt: h.completed_at?.toISOString() ?? null,
      })),
    };
  }

  /** POST …/approve (S4): staff approval, with optional entered data; V5, V6 and V4 re-run. */
  async approve(
    adminId: string,
    attemptId: string,
    body: ApproveVerificationDto,
  ): Promise<VerificationDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const attempt = await this.lockReviewable(manager, attemptId, APPROVABLE);

      // Approving one blocked attempt can't help while others keep the user blocked (recompute).
      if (attempt.outcome === VerificationOutcome.Blocked) {
        const [other] = await manager.query<unknown[]>(
          `SELECT 1 FROM identity_verifications
           WHERE user_id = $1 AND outcome = 'blocked' AND id <> $2 LIMIT 1`,
          [attempt.user_id, attempt.id],
        );
        if (other) throw conflict('OTHER_BLOCKED_ATTEMPTS');
      }

      const entered: string[] = [];
      let hashes = await manager.query<{ hash: string }[]>(
        `SELECT hash FROM identity_hashes WHERE verification_id = $1`,
        [attempt.id],
      );

      if (
        body.idNumber !== undefined ||
        body.documentType !== undefined ||
        body.issuingCountry !== undefined
      ) {
        // Only in the V8 case: attaching a number to an attempt that already has Didit's could
        // put someone else's identity on this account and later block its real owner via V6.
        if (hashes.length > 0) throw conflict('IDENTIFIER_ALREADY_PRESENT');
        const identifier = parseEnteredIdentifier(body);
        const hash = this.hasher.hash(identifier);
        await manager.query(
          `INSERT INTO identity_hashes (verification_id, user_id, kind, hash) VALUES ($1, $2, $3, $4)`,
          [attempt.id, attempt.user_id, identifier.kind, hash],
        );
        await manager.query(
          `UPDATE identity_verifications SET document_type = coalesce(document_type, $2) WHERE id = $1`,
          [attempt.id, DOCUMENT_TYPE_LABEL[identifier.kind]],
        );
        hashes = [...hashes, { hash }];
        entered.push(
          'documentType',
          'idNumber',
          ...(identifier.kind === IdentityKind.Passport
            ? ['issuingCountry']
            : []),
        );
      }

      // Staff corrections change the effective values only; provider_* keep Didit's (spec S4).
      if (body.dateOfBirth !== undefined) {
        if (!isIsoDate(body.dateOfBirth))
          throw new BadRequestException({ code: 'VALIDATION_FAILED' });
        attempt.date_of_birth = body.dateOfBirth;
        entered.push('dateOfBirth');
      }
      if (body.fullName !== undefined) {
        attempt.verified_name = body.fullName.trim();
        entered.push('fullName');
      }

      const missing = [
        ...(hashes.length === 0 ? ['idNumber'] : []),
        ...(!attempt.date_of_birth ? ['dateOfBirth'] : []),
        ...(!attempt.verified_name ? ['fullName'] : []),
      ];
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'MISSING_IDENTITY_DATA',
          missing,
        });
      }

      await this.recheck(
        manager,
        attempt,
        hashes.map((h) => h.hash),
      );
      if (!(await this.decisions.approveHashes(manager, attempt.id))) {
        throw conflict('DUPLICATE_IDENTITY'); // V6 under a race
      }

      await manager.query(
        `UPDATE identity_verifications
         SET outcome = 'approved', decline_reason = NULL, verified_name = $2, date_of_birth = $3,
             decided_by_admin_id = $4, decided_at = clock_timestamp(), completed_at = clock_timestamp(),
             verification_url = NULL, session_token = NULL
         WHERE id = $1`,
        [attempt.id, attempt.verified_name, attempt.date_of_birth, adminId],
      );
      await this.decisions.syncUser(manager, attempt.user_id);
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.VerificationApprove,
        targetType: AuditTargetType.IdentityVerification,
        targetId: attempt.id,
        details: {
          note: body.note,
          enteredFields: entered,
          previousOutcome: attempt.outcome,
          newOutcome: VerificationOutcome.Approved,
        },
      });
    });
    return this.detail(attemptId);
  }

  /** POST …/decline: a final staff decision; the user goes back to normal V3 retry rules. */
  async decline(
    adminId: string,
    attemptId: string,
    body: DeclineVerificationDto,
  ): Promise<VerificationDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      // Only manual_review: declining a blocked attempt would quietly unblock the user.
      const attempt = await this.lockReviewable(manager, attemptId, [
        VerificationOutcome.ManualReview,
      ]);
      await manager.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', decline_reason = $2, decided_by_admin_id = $3,
             decided_at = clock_timestamp(), completed_at = clock_timestamp(),
             verification_url = NULL, session_token = NULL
         WHERE id = $1`,
        [attempt.id, body.reasonCode, adminId],
      );
      await this.decisions.syncUser(manager, attempt.user_id);
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.VerificationDecline,
        targetType: AuditTargetType.IdentityVerification,
        targetId: attempt.id,
        details: {
          reasonCode: body.reasonCode,
          note: body.note,
          previousOutcome: attempt.outcome,
          newOutcome: VerificationOutcome.Declined,
        },
      });
    });
    return this.detail(attemptId);
  }

  private async lockReviewable(
    manager: EntityManager,
    attemptId: string,
    allowed: VerificationOutcome[],
  ): Promise<AttemptRow> {
    const [attempt] = await manager.query<AttemptRow[]>(
      `SELECT id, user_id, outcome, decided_by_admin_id IS NOT NULL AS decided,
              verified_name, date_of_birth::text, document_type
       FROM identity_verifications WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
    if (!attempt) throw attemptNotFound();
    if (attempt.decided) throw conflict('ALREADY_DECIDED');
    if (!allowed.includes(attempt.outcome))
      throw conflict('ATTEMPT_NOT_REVIEWABLE');
    return attempt;
  }

  /** S4: V5, V6 and V4 again, on all of the attempt's hashes (including entered ones). */
  private async recheck(
    manager: EntityManager,
    attempt: AttemptRow,
    hashes: string[],
  ): Promise<void> {
    const [banned] = await manager.query<unknown[]>(
      `SELECT 1 FROM banned_identities WHERE hash = ANY($1) AND lifted_at IS NULL LIMIT 1`,
      [hashes],
    );
    if (banned) throw conflict('BANNED_IDENTITY');
    const [duplicate] = await manager.query<unknown[]>(
      `SELECT 1 FROM identity_hashes WHERE hash = ANY($1) AND is_approved AND user_id <> $2 LIMIT 1`,
      [hashes, attempt.user_id],
    );
    if (duplicate) throw conflict('DUPLICATE_IDENTITY');
    if (isUnder18(attempt.date_of_birth!, todayIn(DECISION_TIME_ZONE)))
      throw conflict('UNDERAGE');
  }
}

/** documentType + idNumber (+ issuingCountry for passports), in the formats V10 hashes. */
function parseEnteredIdentifier(
  body: ApproveVerificationDto,
): IdentityIdentifier {
  const { documentType, idNumber, issuingCountry } = body;
  if (!documentType || !idNumber) throw invalidIdNumber();
  const number = normaliseIdNumber(idNumber);

  if (documentType === IdentityKind.Passport) {
    const country = issuingCountry?.normalize('NFKC').trim().toUpperCase();
    if (!country || !ALPHA_3.test(country) || !PASSPORT_NUMBER.test(number))
      throw invalidIdNumber();
    return { kind: IdentityKind.Passport, number, country };
  }
  if (issuingCountry !== undefined) throw invalidIdNumber(); // Fayda numbers have no country
  if (!/^\d+$/.test(number) || number.length !== FIN_OR_FAN[documentType])
    throw invalidIdNumber();
  return { kind: documentType, number };
}

interface QueueRow {
  id: string;
  user_id: string;
  outcome: string;
  provider_status: string;
  provider_session_id: string;
  flag_reason: string | null;
  decline_reason: string | null;
  manual_review_requested_at: Date | null;
  document_type: string | null;
  verified_name: string | null;
  date_of_birth: string | null;
  decided: boolean;
  created_at: Date;
  phone: string;
  user_status: string;
  verification_status: string;
}

interface HistoryRow {
  id: string;
  outcome: string;
  provider_status: string;
  decline_reason: string | null;
  flag_reason: string | null;
  decided: boolean;
  created_at: Date;
  completed_at: Date | null;
}

const QUEUE_SELECT = `SELECT a.id, a.user_id, a.outcome, a.provider_status, a.provider_session_id,
         a.flag_reason, a.decline_reason, a.manual_review_requested_at, a.document_type,
         a.verified_name, a.date_of_birth::text, a.decided_by_admin_id IS NOT NULL AS decided,
         a.created_at, u.phone, u.status AS user_status, u.verification_status`;

/** A plain object with QueueItemDto's shape (safe to spread into the detail response). */
type QueueItem = { [K in keyof QueueItemDto]: QueueItemDto[K] };

function toQueueItem(row: QueueRow): QueueItem {
  return {
    attemptId: row.id,
    outcome: row.outcome,
    providerStatus: row.provider_status,
    providerSessionId: row.provider_session_id,
    flagReason: row.flag_reason,
    declineReason: row.decline_reason,
    manualReviewRequestedAt:
      row.manual_review_requested_at?.toISOString() ?? null,
    documentType: row.document_type,
    verifiedName: row.verified_name,
    dateOfBirth: row.date_of_birth,
    decided: row.decided,
    createdAt: row.created_at.toISOString(),
    user: {
      id: row.user_id,
      phone: row.phone,
      status: row.user_status,
      verificationStatus: row.verification_status,
    },
  };
}
