import { parseAttachmentRoots } from './mail/attachment-policy.mjs';

/** Profile/principal name used for native data isolation (fail closed). */
export const AGENTMAIL_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const REQUIRED = [
  'AGENTMAIL_DB_PATH',
  'AGENTMAIL_SYNC_INTERVAL_SECONDS',
  'AGENTMAIL_LOG_LEVEL',
  'AGENTMAIL_TRANSPORT',
  'AGENTMAIL_PRINCIPAL',
  'SECRET_FABRIC_PRINCIPAL',
  'SECRET_FABRIC_URL',
  'SECRET_FABRIC_API_TOKEN',
  'CREDENTIAL_CACHE_KEY'
];

/**
 * Load and validate runtime configuration from environment variables.
 * @param {Record<string, string|undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]?.trim?.());
  if (missing.length) throw new Error(`missing required runtime configuration: ${missing.join(', ')}`);
  const interval = Number(env.AGENTMAIL_SYNC_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < 30) throw new Error('AGENTMAIL_SYNC_INTERVAL_SECONDS must be an integer >= 30');
  if (!['stdio', 'streamable-http'].includes(env.AGENTMAIL_TRANSPORT)) throw new Error('AGENTMAIL_TRANSPORT must be stdio or streamable-http');
  if (!['debug', 'info', 'warn', 'error'].includes(env.AGENTMAIL_LOG_LEVEL)) throw new Error('AGENTMAIL_LOG_LEVEL is invalid');
  const principal = String(env.AGENTMAIL_PRINCIPAL).trim();
  if (!principal) throw new Error('AGENTMAIL_PRINCIPAL must be a non-empty string');
  const secretFabricPrincipal = String(env.SECRET_FABRIC_PRINCIPAL).trim();
  if (!secretFabricPrincipal) throw new Error('SECRET_FABRIC_PRINCIPAL must be a non-empty string');
  if (principal !== secretFabricPrincipal) {
    throw new Error('AGENTMAIL_PRINCIPAL must match SECRET_FABRIC_PRINCIPAL');
  }
  const serviceMode = String(env.AGENTMAIL_SERVICE_MODE ?? 'native').trim();
  if (serviceMode !== 'native') {
    throw new Error('AGENTMAIL_SERVICE_MODE must be native');
  }
  const credentialCacheKey = readCredentialCacheKey(env);
  return {
    dbPath: env.AGENTMAIL_DB_PATH,
    syncIntervalSeconds: interval,
    logLevel: env.AGENTMAIL_LOG_LEVEL,
    transport: env.AGENTMAIL_TRANSPORT,
    principal,
    secretFabricPrincipal,
    secretFabricUrl: env.SECRET_FABRIC_URL,
    secretFabricApiToken: env.SECRET_FABRIC_API_TOKEN,
    serviceMode,
    credentialCacheKey,
    attachmentRoots: parseAttachmentRoots(env.AGENTMAIL_ATTACHMENT_ROOTS)
  };
}

/**
 * Require the external 32-byte hex cache key. It is not stored or logged.
 * @param {Record<string, string|undefined>} env Process environment.
 * @returns {string}
 */
function readCredentialCacheKey(env) {
  const value = String(env.CREDENTIAL_CACHE_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('CREDENTIAL_CACHE_KEY must be a 32-byte hexadecimal key');
  }
  return value;
}

/**
 * Load runtime configuration for the long-lived sync worker (profile-scoped principal, no MCP args).
 * @param {Record<string, string|undefined>} [env]
 */
export function loadWorkerConfig(env = process.env) {
  const profile = String(env.AGENTMAIL_PROFILE ?? '').trim();
  if (!profile) throw new Error('AGENTMAIL_PROFILE is required for the sync worker');
  if (!AGENTMAIL_PROFILE_PATTERN.test(profile)) throw new Error('AGENTMAIL_PROFILE is invalid');
  return loadConfig({
    ...env,
    AGENTMAIL_PRINCIPAL: profile,
    SECRET_FABRIC_PRINCIPAL: profile
  });
}
