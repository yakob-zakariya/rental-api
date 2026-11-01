// `npm run didit:inspect -- <attempt id | Didit session id>` or `-- --latest`: fetches the Didit
// decision for one attempt and prints only its shape (see inspect-decision.lib.ts). Used in T2.9
// to learn what Didit returns for real documents without exposing personal data. Uses the Didit
// app configured in .env (sandbox or live).
import { parseArgs } from 'node:util';
// Importing the data source loads .env first (process.loadEnvFile).
import dataSource from '../database/data-source.js';
import { validateEnv } from '../config/env.validation.js';
import { HttpDiditClient } from '../modules/verification/didit/http-didit-client.js';
import { inspectDecision } from './inspect-decision.lib.js';

const USAGE =
  'Usage: npm run didit:inspect -- <attempt id | Didit session id>  (or -- --latest)';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { latest: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (values.latest === (positionals.length === 1) || positionals.length > 1) {
    throw new Error(USAGE);
  }

  const env = validateEnv(process.env);
  await dataSource.initialize();
  let sessionId: string;
  let label: string;
  try {
    const [row] = await dataSource.query<
      { id: string; provider_session_id: string; outcome: string }[]
    >(
      values.latest
        ? `SELECT id, provider_session_id, outcome FROM identity_verifications
           ORDER BY created_at DESC LIMIT 1`
        : `SELECT id, provider_session_id, outcome FROM identity_verifications
           WHERE id::text = $1 OR provider_session_id = $1`,
      values.latest ? [] : [positionals[0]],
    );
    if (row) {
      sessionId = row.provider_session_id;
      label = `attempt ${row.id} (our outcome: ${row.outcome})`;
    } else if (values.latest) {
      throw new Error('No attempts in this database');
    } else {
      sessionId = positionals[0];
      label = 'a session not in this database';
    }
  } finally {
    await dataSource.destroy();
  }

  const didit = new HttpDiditClient({
    baseUrl: env.DIDIT_BASE_URL,
    apiKey: env.DIDIT_API_KEY,
    workflowId: env.DIDIT_WORKFLOW_ID,
    callbackUrl: env.APP_VERIFICATION_CALLBACK_URL,
  });
  const raw = await didit.getRawDecision(sessionId);
  console.log(
    `Didit ${env.DIDIT_ENVIRONMENT} app, session ${sessionId}, ${label}`,
  );
  console.log(inspectDecision(raw).join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
