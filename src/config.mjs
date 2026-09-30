const REQUIRED = ['AGENTMAIL_DB_PATH', 'AGENTMAIL_SYNC_INTERVAL_SECONDS', 'AGENTMAIL_LOG_LEVEL', 'AGENTMAIL_TRANSPORT', 'AGENTMAIL_PRINCIPAL', 'SECRET_FABRIC_URL', 'SECRET_FABRIC_API_TOKEN'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]?.trim?.());
  if (missing.length) throw new Error(`missing required runtime configuration: ${missing.join(', ')}`);
  const interval = Number(env.AGENTMAIL_SYNC_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < 30) throw new Error('AGENTMAIL_SYNC_INTERVAL_SECONDS must be an integer >= 30');
  if (!['stdio', 'streamable-http'].includes(env.AGENTMAIL_TRANSPORT)) throw new Error('AGENTMAIL_TRANSPORT must be stdio or streamable-http');
  if (!['debug', 'info', 'warn', 'error'].includes(env.AGENTMAIL_LOG_LEVEL)) throw new Error('AGENTMAIL_LOG_LEVEL is invalid');
  const principal = String(env.AGENTMAIL_PRINCIPAL).trim();
  if (!principal) throw new Error('AGENTMAIL_PRINCIPAL must be a non-empty string');
  return {
    dbPath: env.AGENTMAIL_DB_PATH,
    syncIntervalSeconds: interval,
    logLevel: env.AGENTMAIL_LOG_LEVEL,
    transport: env.AGENTMAIL_TRANSPORT,
    principal,
    secretFabricUrl: env.SECRET_FABRIC_URL,
    secretFabricApiToken: env.SECRET_FABRIC_API_TOKEN
  };
}
