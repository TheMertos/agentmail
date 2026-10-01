import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfig } from '../config.mjs';

/**
 * Fail closed unless this process is a native host service with a matching profile.
 * Attachment roots must be absolute directories. Sync and IDLE are not started here.
 * @param {Record<string, string|undefined>} [env] Process environment.
 * @returns {ReturnType<typeof loadConfig>}
 */
export function assertNativeService(env = process.env) {
  if (String(env.AGENTMAIL_SERVICE_MODE ?? '').trim() !== 'native') {
    throw new Error('AGENTMAIL_SERVICE_MODE must be native');
  }
  const config = loadConfig(env);
  const profile = String(env.AGENTMAIL_PROFILE ?? '').trim();
  if (!profile || profile !== config.principal) {
    throw new Error('AGENTMAIL_PROFILE must match AGENTMAIL_PRINCIPAL');
  }
  if (config.attachmentRoots.length === 0) throw new Error('AGENTMAIL_ATTACHMENT_ROOTS is required');
  const attachmentRoots = config.attachmentRoots.map((root) => {
    if (!isAbsolute(root)) throw new Error('AGENTMAIL_ATTACHMENT_ROOTS must be absolute');
    const real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error('AGENTMAIL_ATTACHMENT_ROOTS must be directories');
    return real;
  });
  return { ...config, attachmentRoots };
}
