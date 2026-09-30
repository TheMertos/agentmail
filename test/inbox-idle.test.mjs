import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeaseBroker } from '../src/security/lease-broker.mjs';
import { MailService } from '../src/mail/mail-service.mjs';
import { AccountSyncGate } from '../src/mail/account-sync-gate.mjs';
import { ImapIdleConnection } from '../src/mail/imap-idle-connection.mjs';
import { idleBackoffMs, startInboxIdleWatcher } from '../src/mail/inbox-idle-watcher.mjs';
import { startInboxIdleCoordinator } from '../src/worker/idle-sync.mjs';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {() => boolean} predicate Condition to await.
 * @param {number} [timeoutMs] Deadline.
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await delay(5);
  }
}

/**
 * Controllable IDLE client. idle() stays pending until fail() or close().
 * @returns {object} Fake IMAP IDLE client.
 */
function createIdleClient() {
  const listeners = new Map();
  const commands = [];
  let rejectIdle = () => {};
  const client = {
    commands,
    async connect() { commands.push('connect'); },
    async mailboxOpen(path) { commands.push(`mailboxOpen:${path}`); },
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    idle() {
      commands.push('idle');
      return new Promise((resolve, reject) => {
        rejectIdle = (error) => reject(error);
        client.endIdle = resolve;
      });
    },
    fail(error) { rejectIdle(error); },
    endIdle() {},
    close() {
      commands.push('close');
      rejectIdle(new Error('closed'));
    },
    async logout() { this.close(); }
  };
  return client;
}

/**
 * @param {object} client IDLE client.
 * @param {string[]} [releases] Release log.
 * @returns {{ client: object, release: () => Promise<void> }} Watch session.
 */
function sessionFor(client, releases = []) {
  return {
    client,
    async release() {
      releases.push('release');
      client.close();
    }
  };
}

test('backoff grows exponentially and stays capped', () => {
  assert.equal(idleBackoffMs(1, 100, 1000), 100);
  assert.equal(idleBackoffMs(2, 100, 1000), 200);
  assert.equal(idleBackoffMs(3, 100, 1000), 400);
  assert.equal(idleBackoffMs(8, 100, 1000), 1000);
});

test('EXISTS and EXPUNGE schedule one debounced inbox sync', async () => {
  const syncs = [];
  const client = createIdleClient();
  const watcher = startInboxIdleWatcher({
    accountId: 'a',
    debounceMs: 40,
    idleTimeoutMs: 5_000,
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 1_000,
    openSession: async () => sessionFor(client),
    onChange: (accountId) => { syncs.push(accountId); }
  });

  try {
    await waitFor(() => client.commands.includes('idle'));
    assert.equal(client.commands.includes('mailboxOpen:INBOX'), true);
    client.emit('exists', { path: 'INBOX', count: 2, prevCount: 1 });
    client.emit('exists', { path: 'INBOX', count: 3, prevCount: 2 });
    await delay(15);
    assert.deepEqual(syncs, []);
    await delay(50);
    assert.deepEqual(syncs, ['a']);
    client.emit('expunge', { path: 'INBOX', seq: 1 });
    await delay(60);
    assert.deepEqual(syncs, ['a', 'a']);
    assert.equal(client.commands.includes('listMailboxes'), false);
  } finally {
    await watcher.stop();
  }
});

test('one account opens a single idle watcher', async () => {
  let opens = 0;
  const coordinator = startInboxIdleCoordinator({
    accounts: [{ id: 'a' }, { id: 'a' }, { id: 'b' }],
    openSession: async () => {
      opens += 1;
      return sessionFor(createIdleClient());
    },
    requestSync: async () => {},
    debounceMs: 20,
    idleTimeoutMs: 5_000,
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 1_000
  });

  try {
    coordinator.watch('a');
    coordinator.watch('b');
    await waitFor(() => opens >= 2);
    assert.equal(opens, 2);
  } finally {
    await coordinator.stop();
  }
});

test('a dropped idle connection reconnects with backoff and then stops', async () => {
  const sleeps = [];
  let opens = 0;
  const watcher = startInboxIdleWatcher({
    accountId: 'a',
    debounceMs: 10,
    idleTimeoutMs: 1_000,
    maxAttempts: 3,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    sleep: async (ms) => { sleeps.push(ms); },
    openSession: async () => {
      opens += 1;
      return {
        client: {
          async connect() {},
          async mailboxOpen() {},
          on() {},
          idle: async () => { throw new Error('socket_closed'); }
        },
        release: async () => {}
      };
    },
    onChange: () => {}
  });

  await watcher.settled;
  assert.equal(opens, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('an idle timeout recycles the connection without blocking the worker', async () => {
  let opens = 0;
  const releases = [];
  const watcher = startInboxIdleWatcher({
    accountId: 'a',
    debounceMs: 10,
    idleTimeoutMs: 25,
    maxAttempts: 2,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    sleep: async () => {},
    openSession: async () => {
      opens += 1;
      return sessionFor(createIdleClient(), releases);
    },
    onChange: () => {}
  });

  try {
    await waitFor(() => opens >= 3, 400);
    assert.ok(releases.length >= 2);
  } finally {
    const started = Date.now();
    await watcher.stop();
    assert.ok(Date.now() - started < 300);
  }
});

test('the interval scheduler still syncs after idle reconnects are exhausted', async () => {
  const syncs = [];
  let idleOpens = 0;
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 0.05 },
    registry: {
      list: () => [{ id: 'a' }],
      get: (id) => (id === 'a' ? { id: 'a' } : undefined)
    },
    mailService: {
      syncAccount: async (accountId) => { syncs.push(accountId); },
      openIdleWatch: async () => {
        idleOpens += 1;
        throw new Error('imap_down');
      }
    },
    store: {}
  }, {
    idle: {
      maxAttempts: 2,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      idleTimeoutMs: 50,
      debounceMs: 5,
      sleep: async () => {}
    }
  });

  try {
    await waitFor(() => idleOpens >= 2 && syncs.length >= 2, 1000);
    await delay(40);
    assert.equal(idleOpens, 2);
    assert.ok(syncs.length >= 2);
    assert.ok(syncs.every((accountId) => accountId === 'a'));
  } finally {
    await stop();
  }
});

test('idle does not start a second sync while that account sync is in progress', async () => {
  let calls = 0;
  let releaseSync = () => {};
  let client;
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    registry: {
      list: () => [{ id: 'a' }],
      get: () => ({ id: 'a' })
    },
    mailService: {
      syncAccount: () => {
        calls += 1;
        return new Promise((resolve) => { releaseSync = () => resolve({ ok: true }); });
      },
      openIdleWatch: async () => {
        client = createIdleClient();
        return sessionFor(client);
      }
    },
    store: {}
  }, {
    idle: {
      debounceMs: 20,
      idleTimeoutMs: 5_000,
      maxAttempts: 2,
      initialBackoffMs: 1_000,
      maxBackoffMs: 1_000
    }
  });

  try {
    await waitFor(() => calls === 1 && client?.commands.includes('idle'));
    client.emit('exists', { path: 'INBOX', count: 4, prevCount: 3 });
    await delay(50);
    assert.equal(calls, 1);
    releaseSync();
    await waitFor(() => calls === 2);
    await delay(30);
    assert.equal(calls, 2);
  } finally {
    releaseSync();
    await stop();
  }
});

test('the same account never overlaps sync and another account can run beside it', async () => {
  const gate = new AccountSyncGate();
  const current = new Map();
  let maxSameAccount = 0;
  let maxTotal = 0;
  let total = 0;

  /**
   * @param {string} accountId Account id.
   * @returns {Promise<void>}
   */
  function sync(accountId) {
    return gate.run(accountId, async () => {
      const count = (current.get(accountId) ?? 0) + 1;
      current.set(accountId, count);
      total += 1;
      maxSameAccount = Math.max(maxSameAccount, count);
      maxTotal = Math.max(maxTotal, total);
      await delay(30);
      current.set(accountId, count - 1);
      total -= 1;
    });
  }

  await Promise.all([sync('a'), sync('a'), sync('b')]);
  assert.equal(maxSameAccount, 1);
  assert.equal(maxTotal, 2);
});

test('shutdown releases the idle provider and the SecretFabric lease', async () => {
  const releases = [];
  let leaseId;
  const broker = createLeaseBroker({
    resolver: async () => ({ username: 'mailbox-user', password: 'mailbox-secret' })
  });
  const service = new MailService({
    accountRegistry: {
      get: () => ({ id: 'a', secretRef: 'sf-ref', connection: { host: 'imap.test', port: 993, security: 'tls' } })
    },
    leaseBroker: broker,
    providerFactory: async ({ operation, lease }) => {
      assert.equal(operation, 'imap-idle');
      assert.equal(JSON.stringify(lease).includes('mailbox-secret'), false);
      assert.equal(lease.credentials.password, 'mailbox-secret');
      leaseId = lease.leaseId;
      const client = createIdleClient();
      return client;
    }
  });
  const watcher = startInboxIdleWatcher({
    accountId: 'a',
    debounceMs: 20,
    idleTimeoutMs: 5_000,
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 1_000,
    openSession: () => service.openIdleWatch('a'),
    onChange: () => { releases.push('sync'); }
  });

  try {
    await waitFor(() => Boolean(leaseId));
    const opened = broker.getPrivate(leaseId);
    assert.equal(opened.password, 'mailbox-secret');
  } finally {
    const started = Date.now();
    await watcher.stop();
    assert.ok(Date.now() - started < 300);
  }

  assert.equal(broker.getPrivate(leaseId), null);
  assert.deepEqual(releases, []);
});

test('openIdleWatch releases the lease when the provider cannot be opened', async () => {
  let released = null;
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'a' }) },
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-idle' }),
      release: async (lease) => { released = lease.leaseId; }
    },
    providerFactory: async () => { throw new Error('connect_failed'); }
  });
  await assert.rejects(() => service.openIdleWatch('a'), /connect_failed/);
  assert.equal(released, 'lease-idle');
});

test('mailbox sync uses a different client from the idle watcher', async () => {
  const clients = [];
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'a' }) },
    leaseBroker: {
      acquire: async ({ purpose }) => ({ leaseId: `lease-${purpose}` }),
      release: async () => {}
    },
    providerFactory: async ({ operation }) => {
      const client = createIdleClient();
      client.operation = operation;
      client.listMailboxes = async () => {
        client.commands.push('listMailboxes');
        return [];
      };
      clients.push(client);
      return client;
    }
  });
  const watcher = startInboxIdleWatcher({
    accountId: 'a',
    debounceMs: 20,
    idleTimeoutMs: 5_000,
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 1_000,
    openSession: () => service.openIdleWatch('a'),
    onChange: () => service.syncAccount('a', {
      mode: 'incremental',
      store: { getCheckpoint: async () => null }
    })
  });

  try {
    await waitFor(() => clients.some((client) => client.operation === 'imap-idle' && client.commands.includes('idle')));
    const idle = clients.find((client) => client.operation === 'imap-idle');
    idle.emit('exists', { path: 'INBOX', count: 2, prevCount: 1 });
    await waitFor(() => clients.some((client) => client.operation === 'imap-sync'));
    const sync = clients.find((client) => client.operation === 'imap-sync');
    assert.notEqual(idle, sync);
    assert.equal(idle.commands.includes('listMailboxes'), false);
    assert.equal(sync.commands.includes('idle'), false);
    assert.equal(sync.commands.includes('listMailboxes'), true);
  } finally {
    await watcher.stop();
  }
});

test('idle connection close logs out its own client', async () => {
  let loggedOut = 0;
  const connection = new ImapIdleConnection({
    connection: { host: 'imap.test', port: 993, security: 'tls' },
    credentials: { username: 'u', password: 'p' },
    createClient: () => ({
      async connect() {},
      async mailboxOpen() {},
      async idle() {},
      on() {},
      async logout() { loggedOut += 1; },
      close() {}
    })
  });
  await connection.close();
  assert.equal(loggedOut, 1);
});

test('MCP does not start idle or mailbox sync', () => {
  const server = readFileSync(join(repoRoot, 'src/mcp/server.mjs'), 'utf8');
  const worker = readFileSync(join(repoRoot, 'src/worker/durable-sync.mjs'), 'utf8');
  assert.doesNotMatch(server, /openIdleWatch|startInboxIdle|imap-idle|syncAccount\(/);
  assert.match(worker, /openIdleWatch/);
  assert.match(worker, /mailService\.syncAccount/);
});
