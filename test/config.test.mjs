import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('runtime configuration is mandatory', () => {
  assert.throws(() => loadConfig({}), /AGENTMAIL_DB_PATH/);
});

test('runtime configuration validates values', () => {
  const config = loadConfig({ AGENTMAIL_DB_PATH: '/data/agentmail.db', AGENTMAIL_SYNC_INTERVAL_SECONDS: '300', AGENTMAIL_LOG_LEVEL: 'info', AGENTMAIL_TRANSPORT: 'stdio' });
  assert.deepEqual(config, { dbPath: '/data/agentmail.db', syncIntervalSeconds: 300, logLevel: 'info', transport: 'stdio' });
});
