import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';
import { createMailRuntime } from '../src/runtime/mail-runtime.mjs';
import { HERMES_PRINCIPAL_HEADER } from '../src/security/secretfabric-resolver.mjs';
import { TEST_PRINCIPAL } from './test-principal.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('compose and image entrypoint run MCP and do not start the sync worker', () => {
  const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(compose, /command:\s*\["node",\s*"src\/mcp\/server\.mjs"\]/);
  assert.doesNotMatch(compose, /sync-runtime-worker/);
  assert.doesNotMatch(compose, /sleep.*infinity/);
  assert.match(compose, /AGENTMAIL_PROFILE:\s*\$\{AGENTMAIL_PROFILE:-default\}/);
  assert.match(compose, /AGENTMAIL_PRINCIPAL:\s*\$\{AGENTMAIL_PROFILE:-default\}/);
  assert.match(compose, /SECRET_FABRIC_PRINCIPAL:\s*\$\{AGENTMAIL_PROFILE:-default\}/);
  assert.doesNotMatch(compose, /\$\{AGENTMAIL_PRINCIPAL/);
  assert.doesNotMatch(compose, /\$\{SECRET_FABRIC_PRINCIPAL/);
  assert.match(compose, /restart:\s*always/);
  assert.match(compose, /agentmail-data:/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "src\/mcp\/server\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /sync-runtime-worker/);
});

test('MCP server does not enqueue or start mailbox sync', () => {
  const server = readFileSync(join(repoRoot, 'src/mcp/server.mjs'), 'utf8');
  const runtime = readFileSync(join(repoRoot, 'src/runtime/mail-runtime.mjs'), 'utf8');
  const worker = readFileSync(join(repoRoot, 'src/worker/sync-runtime-worker.mjs'), 'utf8');
  const durable = readFileSync(join(repoRoot, 'src/worker/durable-sync.mjs'), 'utf8');
  assert.doesNotMatch(server, /mailbox_sync/);
  assert.doesNotMatch(server, /startAccountSync|startAllAccountSync|syncJobService|executeSync|waitForJob/);
  assert.doesNotMatch(runtime, /createSyncJobService|executeSync|syncJobService/);
  assert.match(worker, /remote_only_sync_disabled/);
  assert.doesNotMatch(worker, /startDurableSyncWorker|createMailRuntime|openIdleWatch/);
  assert.doesNotMatch(durable, /mailService\.syncAccount|openIdleWatch|setInterval/);
  assert.doesNotMatch(durable, /startAccountSync|waitForJob|resumeOrphaned/);
});

test('durable sync worker does not run an initial sync cycle', async () => {
  const syncCalls = [];
  const registry = { list: () => [{ id: 'a' }], get: (id) => (id === 'a' ? { id: 'a' } : undefined) };
  const running = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    registry,
    mailService: {
      syncAccount: async (accountId, opts) => {
        syncCalls.push({ accountId, mode: opts.mode });
        return { accountId, folders: [] };
      },
      openIdleWatch: async () => {
        syncCalls.push({ idle: true });
      }
    },
    store: {}
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running.syncEnabled, false);
  assert.equal(running.idleEnabled, false);
  assert.deepEqual(syncCalls, []);
  running.stop();
});

test('worker interval does not sync without another process', async () => {
  const syncCalls = [];
  const registry = { list: () => [{ id: 'a' }], get: (id) => (id === 'a' ? { id: 'a' } : undefined) };
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 0.05 },
    registry,
    mailService: {
      syncAccount: async (accountId, opts) => {
        syncCalls.push({ accountId, mode: opts.mode });
        return { accountId, folders: [] };
      }
    },
    store: {}
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(syncCalls, []);
  } finally {
    stop();
  }
});

test('disabled worker does not sync through SecretFabric or IMAP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-worker-runtime-'));
  const dbPath = join(dir, 'mail.db');
  const fetches = [];
  const providerCalls = [];

  /**
   * @param {string} url Request URL.
   * @param {{ headers?: Record<string, string>, body?: string }} init Fetch init.
   * @returns {Promise<{ ok: boolean, status: number, json: () => Promise<object> }>}
   */
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    fetches.push({
      url,
      principal: init.headers[HERMES_PRINCIPAL_HEADER],
      authorization: init.headers.authorization,
      resourceId: body.resourceId,
      purpose: body.purpose
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          fields: {
            'incoming.username': 'mailbox-user',
            'incoming.password': 'mailbox-secret'
          }
        };
      }
    };
  }

  /**
   * @param {{ account: { id: string, secretRef: string }, lease: { credentials?: { username?: string } }, operation: string }} input Provider input.
   * @returns {Promise<object>} Fake IMAP provider.
   */
  async function providerFactory({ account, lease, operation }) {
    providerCalls.push({
      accountId: account.id,
      secretRef: account.secretRef,
      operation,
      username: lease.credentials?.username ?? null
    });
    if (operation === 'imap-idle') {
      let rejectIdle = () => {};
      return {
        async connect() {},
        async mailboxOpen() {},
        on() {},
        idle() {
          return new Promise((resolve, reject) => { rejectIdle = reject; });
        },
        async close() { rejectIdle(new Error('closed')); }
      };
    }
    return {
      async listMailboxes() {
        return [{ id: 'INBOX', path: 'INBOX', messages: 1, uidNext: 2, uidValidity: '1', flags: [] }];
      },
      async *fetchMessages() {
        yield { uid: 1, uidValidity: '1', raw: 'Subject: hi\r\n\r\nbody', flags: [], attachments: [] };
      },
      async close() {}
    };
  }

  const config = {
    dbPath,
    syncIntervalSeconds: 3600,
    logLevel: 'info',
    transport: 'stdio',
    principal: TEST_PRINCIPAL,
    secretFabricPrincipal: TEST_PRINCIPAL,
    secretFabricUrl: 'http://secretfabric.test',
    secretFabricApiToken: 'test-token'
  };
  const worker = createMailRuntime(config, { fetchImpl, providerFactory });
  let stop = () => {};
  try {
    worker.registry.register({
      id: 'a',
      email: 'a@example.test',
      provider: 'imap',
      secretRef: 'sf-ref',
      connection: { imap: { host: 'imap.test', port: 993, security: 'tls' } }
    });
    assert.equal(worker.syncJobService, undefined);
    assert.equal(fetches.length, 0);
    assert.equal(worker.store.countMessages('a'), 0);

    ({ stop } = startDurableSyncWorker({
      config: worker.config,
      registry: worker.registry,
      mailService: worker.mailService,
      store: worker.store
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(worker.store.countMessages('a'), 0);
    assert.deepEqual(fetches, []);
    assert.deepEqual(providerCalls, []);
    assert.equal(worker.registry.get('a').secretRef, 'sf-ref');
  } finally {
    await stop();
    worker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
