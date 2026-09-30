import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from '../config.mjs';
import { createMailRuntime } from '../runtime/mail-runtime.mjs';
import { startDurableSyncWorker } from './durable-sync.mjs';

/**
 * Long-lived container entrypoint: profile-scoped config, durable sync, no MCP stdio.
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
    process.stderr.write(`AgentMail sync worker error: ${error.message}\n`);
    process.exit(1);
  }
}
