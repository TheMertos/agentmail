import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from '../security/redact.mjs';

/**
 * Worker entrypoint is disabled in remote-only mode.
 * It does not open SQLite, SecretFabric, IMAP, or IMAP IDLE.
 * @returns {never}
 */
export function runSyncRuntimeWorker() {
  const error = new Error('remote_only_sync_disabled');
  error.code = 'remote_only_sync_disabled';
  throw error;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    runSyncRuntimeWorker();
  } catch (error) {
    process.stderr.write(`AgentMail sync worker error: ${redactSensitiveText(error?.message ?? '')}\n`);
    process.exit(1);
  }
}
