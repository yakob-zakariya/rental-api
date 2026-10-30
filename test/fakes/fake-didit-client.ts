import { randomBytes, randomUUID } from 'node:crypto';
import { DiditApiError } from '../../src/modules/verification/didit/didit-api.error.js';
import { DiditClient } from '../../src/modules/verification/didit/didit-client.js';
import {
  type DiditDecision,
  type DiditIdVerification,
  type DiditSession,
  DiditStatus,
} from '../../src/modules/verification/didit/didit.types.js';

// Statuses in which Didit reuses the session for a repeated create (docs/didit-integration.md §1).
const UNFINISHED: string[] = [
  DiditStatus.NotStarted,
  DiditStatus.InProgress,
  DiditStatus.Resubmitted,
  DiditStatus.AwaitingUser,
];

interface FakeSession {
  session: DiditSession;
  vendorData: string;
  idVerifications: DiditIdVerification[];
}

/**
 * In-memory Didit. Like the real API, createSession returns the existing session while the same
 * vendorData still has an unfinished one. Use setStatus / setIdVerifications to script outcomes,
 * and failNextWith to simulate API errors.
 */
export class FakeDiditClient extends DiditClient {
  private readonly sessions = new Map<string, FakeSession>();
  private nextError: DiditApiError | null = null;
  /** How many genuinely new sessions were created (reused ones don't count). */
  createdCount = 0;

  // async, so scripted failures reject like the real client's instead of throwing synchronously.
  async createSession({
    vendorData,
  }: {
    vendorData: string;
  }): Promise<DiditSession> {
    this.throwIfScripted();
    const existing = [...this.sessions.values()].find(
      (s) =>
        s.vendorData === vendorData && UNFINISHED.includes(s.session.status),
    );
    if (existing) return { ...existing.session };

    const token = randomBytes(9).toString('base64url'); // 12 characters, like Didit's
    const session: DiditSession = {
      sessionId: randomUUID(),
      sessionToken: token,
      url: `https://verify.didit.me/session/${token}`,
      status: DiditStatus.NotStarted,
    };
    this.sessions.set(session.sessionId, {
      session,
      vendorData,
      idVerifications: [],
    });
    this.createdCount++;
    return { ...session };
  }

  async getDecision(sessionId: string): Promise<DiditDecision> {
    this.throwIfScripted();
    const fake = this.sessions.get(sessionId);
    if (!fake)
      throw new DiditApiError('not_found', 'Didit fake: not found', 404);
    return {
      sessionId,
      status: fake.session.status,
      vendorData: fake.vendorData,
      idVerifications: fake.idVerifications.map((item) => ({ ...item })),
    };
  }

  setStatus(sessionId: string, status: string): void {
    this.get(sessionId).session.status = status;
  }

  setIdVerifications(
    sessionId: string,
    items: Partial<DiditIdVerification>[],
  ): void {
    this.get(sessionId).idVerifications = items.map((item) => ({
      status: null,
      documentType: null,
      documentSubtype: null,
      documentNumber: null,
      personalNumber: null,
      issuingState: null,
      dateOfBirth: null,
      fullName: null,
      firstName: null,
      lastName: null,
      ...item,
    }));
  }

  /** The next createSession/getDecision call rejects with this error. */
  failNextWith(error: DiditApiError): void {
    this.nextError = error;
  }

  reset(): void {
    this.sessions.clear();
    this.nextError = null;
    this.createdCount = 0;
  }

  private get(sessionId: string): FakeSession {
    const fake = this.sessions.get(sessionId);
    if (!fake) throw new Error(`FakeDiditClient: unknown session ${sessionId}`);
    return fake;
  }

  private throwIfScripted(): void {
    if (!this.nextError) return;
    const error = this.nextError;
    this.nextError = null;
    throw error;
  }
}
