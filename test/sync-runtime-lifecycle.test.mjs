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

test('compose and image entrypoint run the durable sync worker', () => {
  const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(compose, /command:\s*\["node",\s*"src\/worker\/sync-runtime-worker\.mjs"\]/);
  assert.doesNotMatch(compose, /sleep.*infinity/);
  assert.match(compose, /AGENTMAIL_PROFILE/);
  assert.match(compose, /restart:\s*always/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "src\/worker\/sync-runtime-worker\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /src\/mcp\/server\.mjs/);
});

test('MCP server does not enqueue or start mailbox sync', () => {
  const server = readFileSync(join(repoRoot, 'src/mcp/server.mjs'), 'utf8');
  const runtime = readFileSync(join(repoRoot, 'src/runtime/mail-runtime.mjs'), 'utf8');
  const worker = readFileSync(join(repoRoot, 'src/worker/sync-runtime-worker.mjs'), 'utf8');
  const durable = readFileSync(join(repoRoot, 'src/worker/durable-sync.mjs'), 'utf8');
  assert.doesNotMatch(server, /mailbox_sync/);
  assert.doesNotMatch(server, /startAccountSync|startAllAccountSync|syncJobService|executeSync|waitForJob/);
  assert.doesNotMatch(runtime, /createSyncJobService|executeSync|syncJobService/);
  assert.match(worker, /createMailRuntime\(config\)/);
  assert.match(worker, /startDurableSyncWorker\(runtime\)/);
  assert.doesNotMatch(worker, /executeSync/);
  assert.match(durable, /mailService\.syncAccount/);
  assert.doesNotMatch(durable, /startAccountSync|waitForJob|resumeOrphaned/);
});

test('durable sync worker starts and runs an initial sync cycle', async () => {
  const syncCalls = [];
  const registry = { list: () => [{ id: 'a' }], get: (id) => (id === 'a' ? { id: 'a' } : undefined) };
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    registry,
    mailService: {
      syncAccount: async (accountId, opts) => {
        syncCalls.push({ accountId, mode: opts.mode });
        return { accountId, folders: [] };
      }
    },
    store: {}
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].accountId, 'a');
  assert.equal(syncCalls[0].mode, 'incremental');
  stop();
});

test('worker interval syncs again without another process', async () => {
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
    const outcome = await Promise.race([
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (syncCalls.length >= 2) {
            clearInterval(timer);
            resolve('done');
          }
        }, 10);
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))
    ]);
    assert.equal(outcome, 'done');
    assert.ok(syncCalls.length >= 2);
    assert.ok(syncCalls.every((call) => call.accountId === 'a' && call.mode === 'incremental'));
  } finally {
    stop();
  }
});

test('worker syncs through the principal registry, SecretFabric, and mailService', async () => {
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

    const outcome = await Promise.race([
      (async () => {
        while (worker.store.countMessages('a') < 1 || !fetches.some((entry) => entry.purpose === 'imap-idle')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return 'done';
      })(),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
    ]);
    assert.equal(outcome, 'done');
    assert.equal(worker.store.countMessages('a'), 1);
    const syncFetch = fetches.find((entry) => entry.purpose === 'imap-sync');
    const idleFetch = fetches.find((entry) => entry.purpose === 'imap-idle');
    assert.ok(syncFetch);
    assert.ok(idleFetch);
    assert.equal(syncFetch.url, 'http://secretfabric.test/api/resolve');
    assert.equal(syncFetch.principal, TEST_PRINCIPAL);
    assert.equal(syncFetch.authorization, 'Bearer test-token');
    assert.equal(syncFetch.resourceId, 'sf-ref');
    assert.equal(idleFetch.resourceId, 'sf-ref');
    assert.equal(idleFetch.principal, TEST_PRINCIPAL);
    const syncProvider = providerCalls.find((call) => call.operation === 'imap-sync');
    const idleProvider = providerCalls.find((call) => call.operation === 'imap-idle');
    assert.equal(syncProvider.accountId, 'a');
    assert.equal(syncProvider.secretRef, 'sf-ref');
    assert.equal(syncProvider.username, 'mailbox-user');
    assert.equal(idleProvider.accountId, 'a');
    assert.equal(idleProvider.username, 'mailbox-user');
    assert.equal(worker.registry.get('a').secretRef, 'sf-ref');
  } finally {
    await stop();
    worker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
