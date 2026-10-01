import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadWorkerConfig } from '../src/config.mjs';

const BASE_ENV = {
  AGENTMAIL_DB_PATH: '/data/agentmail.db',
  AGENTMAIL_SYNC_INTERVAL_SECONDS: '300',
  AGENTMAIL_LOG_LEVEL: 'info',
  AGENTMAIL_TRANSPORT: 'stdio',
  AGENTMAIL_PRINCIPAL: 'mert',
  SECRET_FABRIC_PRINCIPAL: 'mert',
  SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
  SECRET_FABRIC_API_TOKEN: 'tok'
};

test('runtime configuration is mandatory', () => {
  assert.throws(() => loadConfig({}), /AGENTMAIL_DB_PATH/);
});

test('runtime configuration requires AGENTMAIL_PRINCIPAL', () => {
  const { AGENTMAIL_PRINCIPAL: _removed, ...env } = BASE_ENV;
  assert.throws(() => loadConfig(env), /AGENTMAIL_PRINCIPAL/);
});

test('runtime configuration requires SECRET_FABRIC_PRINCIPAL', () => {
  const { SECRET_FABRIC_PRINCIPAL: _removed, ...env } = BASE_ENV;
  assert.throws(() => loadConfig(env), /SECRET_FABRIC_PRINCIPAL/);
});

test('runtime configuration rejects mismatched principals', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, SECRET_FABRIC_PRINCIPAL: 'other' }),
    /must match SECRET_FABRIC_PRINCIPAL/
  );
});

test('runtime configuration validates values', () => {
  const config = loadConfig(BASE_ENV);
  assert.deepEqual(config, {
    dbPath: '/data/agentmail.db',
    syncIntervalSeconds: 300,
    logLevel: 'info',
    transport: 'stdio',
    principal: 'mert',
    secretFabricPrincipal: 'mert',
    secretFabricUrl: 'http://127.0.0.1:3000',
    secretFabricApiToken: 'tok',
    serviceMode: 'native',
    attachmentRoots: []
  });
});

test('worker configuration requires AGENTMAIL_PROFILE and maps principal', () => {
  const { AGENTMAIL_PRINCIPAL: _p, SECRET_FABRIC_PRINCIPAL: _s, ...base } = BASE_ENV;
  assert.throws(() => loadWorkerConfig(base), /AGENTMAIL_PROFILE/);
  const config = loadWorkerConfig({ ...base, AGENTMAIL_PROFILE: 'mert' });
  assert.equal(config.principal, 'mert');
  assert.equal(config.secretFabricPrincipal, 'mert');
});
