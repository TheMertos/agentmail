import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from '../config.mjs';
import { redactSensitiveText } from '../security/redact.mjs';
import { createMailRuntime } from '../runtime/mail-runtime.mjs';
import { startDurableSyncWorker } from './durable-sync.mjs';

/**
 * Long-lived container entrypoint.
 * Loads profile-scoped config and runs mailbox sync on its own interval through mailService.
 * Does not attach MCP stdio and does not wait for another process to enqueue or finish sync.
 */
export function runSyncRuntimeWorker() {
  const config = loadWorkerConfig();
  const runtime = createMailRuntime(config);
  startDurableSyncWorker(runtime);
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
