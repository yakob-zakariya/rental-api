import type { DiditDecision, DiditSession } from './didit.types.js';

/**
 * Didit's Sessions API. Inject `DiditClient`; DiditModule provides HttpDiditClient, and tests use
 * test/fakes/fake-didit-client.ts. Implementations never return image URLs or unneeded personal
 * data, and never log raw responses (hard rule 1).
 */
export abstract class DiditClient {
  /**
   * Creates a session for `vendorData` (our users.id). If that user already has an unfinished
   * session on the workflow, Didit returns it instead — callers treat a known sessionId as a
   * resume (spec V2, V14).
   */
  abstract createSession(input: { vendorData: string }): Promise<DiditSession>;

  /** The session's current status and trimmed decision data. */
  abstract getDecision(sessionId: string): Promise<DiditDecision>;
}
