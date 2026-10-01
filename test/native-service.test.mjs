import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { assertNativeService } from '../src/runtime/native-service.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const wrapperPath = join(repoRoot, 'tools', 'hermes-agentmail-mcp.sh');
const nativePath = join(repoRoot, 'tools', 'agentmail-native-mcp.sh');
const unitPath = join(repoRoot, 'deploy', 'systemd', 'user', 'agentmail@.service');

const BASE_ENV = {
  AGENTMAIL_DB_PATH: '/data/agentmail.db',
  AGENTMAIL_SYNC_INTERVAL_SECONDS: '300',
  AGENTMAIL_LOG_LEVEL: 'info',
  AGENTMAIL_TRANSPORT: 'stdio',
  AGENTMAIL_PROFILE: 'mert',
  AGENTMAIL_PRINCIPAL: 'mert',
  SECRET_FABRIC_PRINCIPAL: 'mert',
  SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
  SECRET_FABRIC_API_TOKEN: 'tok',
  AGENTMAIL_SERVICE_MODE: 'native',
  AGENTMAIL_ATTACHMENT_ROOTS: '/var/lib/agentmail/mert/outgoing'
};

/**
 * Run a shell entrypoint with a clean Hermes environment.
 * @param {string} script Script path.
 * @param {{ args?: string[], hermesHome?: string, env?: Record<string, string>, pathPrefix?: string }} options
 */
function runScript(script, { args = [], hermesHome, env = {}, pathPrefix = '' } = {}) {
  const merged = {
    ...process.env,
    PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    ...env
  };
  delete merged.HERMES_INSTANCE_NAME;
  delete merged.AGENTMAIL_NATIVE_HOLD;
  if (hermesHome !== undefined) merged.HERMES_HOME = hermesHome;
  else delete merged.HERMES_HOME;
  return spawnSync('bash', [script, ...args], { env: merged, encoding: 'utf8' });
}

/**
 * Fake `node` that records argv and selected environment variables.
 * @returns {{ binDir: string, logPath: string }}
 */
function fakeNode() {
  const binDir = mkdtempSync(join(tmpdir(), 'agentmail-fake-node-'));
  const logPath = join(binDir, 'node.log');
  const fake = join(binDir, 'node');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
{
  printf 'argv:%s\\n' "$*"
  printf 'mode:%s\\n' "\${AGENTMAIL_SERVICE_MODE:-}"
  printf 'profile:%s\\n' "\${AGENTMAIL_PROFILE:-}"
  printf 'principal:%s\\n' "\${AGENTMAIL_PRINCIPAL:-}"
  printf 'sf:%s\\n' "\${SECRET_FABRIC_PRINCIPAL:-}"
  printf 'db:%s\\n' "\${AGENTMAIL_DB_PATH:-}"
  printf 'roots:%s\\n' "\${AGENTMAIL_ATTACHMENT_ROOTS:-}"
  printf 'hold:%s\\n' "\${AGENTMAIL_NATIVE_HOLD:-}"
  printf 'url:%s\\n' "\${SECRET_FABRIC_URL:-}"
} > "${logPath}"
exit 0
`
  );
  chmodSync(fake, 0o755);
  return { binDir, logPath };
}

test('service mode rejects values other than native or docker', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, AGENTMAIL_SERVICE_MODE: 'mirror' }), /AGENTMAIL_SERVICE_MODE/);
});

test('native service mode requires matching profile and absolute attachment roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-native-root-'));
  assert.throws(() => assertNativeService({ ...BASE_ENV, AGENTMAIL_PROFILE: 'other' }), /AGENTMAIL_PROFILE/);
  assert.throws(() => assertNativeService({ ...BASE_ENV, AGENTMAIL_ATTACHMENT_ROOTS: 'relative/out' }), /absolute/);
  assert.throws(() => assertNativeService({ ...BASE_ENV, AGENTMAIL_ATTACHMENT_ROOTS: '' }), /AGENTMAIL_ATTACHMENT_ROOTS/);
  const config = assertNativeService({ ...BASE_ENV, AGENTMAIL_ATTACHMENT_ROOTS: dir });
  assert.equal(config.serviceMode, 'native');
  assert.deepEqual(config.attachmentRoots, [dir]);
});

test('native service mode does not enable sync or idle', () => {
  const source = [
    readFileSync(join(repoRoot, 'src/runtime/native-service.mjs'), 'utf8'),
    readFileSync(nativePath, 'utf8'),
    readFileSync(unitPath, 'utf8')
  ].join('\n');
  assert.doesNotMatch(source, /sync-runtime-worker|openIdleWatch|startDurableSyncWorker/);
  assert.match(readFileSync(unitPath, 'utf8'), /AGENTMAIL_NATIVE_HOLD=1/);
  assert.match(readFileSync(nativePath, 'utf8'), /src\/mcp\/server\.mjs/);
});

test('hermes wrapper runs node with the derived principal and fails closed without secrets', () => {
  const { binDir, logPath } = fakeNode();
  const missing = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: { SECRET_FABRIC_URL: '', SECRET_FABRIC_API_TOKEN: '' }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SECRET_FABRIC_URL/);

  const home = mkdtempSync(join(tmpdir(), 'agentmail-native-home-'));
  const result = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: {
      HOME: home,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /argv:src\/mcp\/server\.mjs/);
  assert.match(log, /mode:native/);
  assert.match(log, /principal:mert/);
  assert.match(log, /sf:mert/);
  assert.match(log, /profile:mert/);
  assert.match(log, new RegExp(`db:${home}/.local/share/agentmail/mert/agentmail.db`));
  assert.match(log, /hold:$/m);
  assert.doesNotMatch(result.stderr + log, /docker exec/);
});

test('native launcher refuses a non-native service mode and a profile mismatch', () => {
  const { binDir } = fakeNode();
  const home = mkdtempSync(join(tmpdir(), 'agentmail-native-home-'));
  const mode = runScript(nativePath, {
    args: ['--service', 'mert'],
    pathPrefix: binDir,
    env: {
      HOME: home,
      AGENTMAIL_SERVICE_MODE: 'docker',
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.notEqual(mode.status, 0);
  assert.match(mode.stderr, /AGENTMAIL_SERVICE_MODE/);

  const mismatch = runScript(nativePath, {
    args: ['--service', 'other'],
    pathPrefix: binDir,
    hermesHome: '/home/user/.hermes/profiles/mert',
    env: {
      HOME: home,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match/);
});

/**
 * Install a fake node that records its launch line.
 * @param {string} binDir Directory that receives the node executable.
 * @param {string} logPath File that receives the launch record.
 */
function installFakeNode(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'node');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
printf 'argv:%s\\n' "$*" > "${logPath}"
exit 0
`
  );
  chmodSync(fake, 0o755);
}

test('native launcher finds node when PATH is the systemd user default', () => {
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /Environment=PATH=%h\/\.local\/bin:%h\/\.hermes\/node\/bin:/);

  const home = mkdtempSync(join(tmpdir(), 'agentmail-systemd-node-'));
  const logPath = join(home, 'node.log');
  installFakeNode(join(home, '.hermes', 'node', 'bin'), logPath);
  const systemdPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const fromHermes = runScript(nativePath, {
    args: ['--service', 'mert'],
    env: {
      HOME: home,
      PATH: systemdPath,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(fromHermes.status, 0, fromHermes.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /argv:src\/mcp\/server\.mjs/);

  const localHome = mkdtempSync(join(tmpdir(), 'agentmail-systemd-local-node-'));
  const localLog = join(localHome, 'node.log');
  installFakeNode(join(localHome, '.local', 'bin'), localLog);
  const fromLocal = runScript(nativePath, {
    args: ['--service', 'mert'],
    env: {
      HOME: localHome,
      PATH: systemdPath,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(fromLocal.status, 0, fromLocal.stderr);
  assert.match(readFileSync(localLog, 'utf8'), /argv:src\/mcp\/server\.mjs/);
});

test('native hold stays running until SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-hold-root-'));
  const root = join(dir, 'outgoing');
  mkdirSync(root);
  const child = spawn(process.execPath, [join(repoRoot, 'src/mcp/server.mjs')], {
    env: {
      ...BASE_ENV,
      AGENTMAIL_DB_PATH: join(dir, 'agentmail.db'),
      AGENTMAIL_ATTACHMENT_ROOTS: root,
      AGENTMAIL_NATIVE_HOLD: '1',
      PATH: process.env.PATH
    },
    stdio: 'ignore'
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const early = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ running: true }), 1000))
  ]);
  assert.equal(early.running, true);
  child.kill('SIGTERM');
  const finished = await exited;
  assert.equal(finished.code, 0);
  assert.equal(finished.signal, null);
});

test('native MCP startup fails closed when native configuration is incomplete', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'src/mcp/server.mjs')], {
    env: {
      ...BASE_ENV,
      AGENTMAIL_ATTACHMENT_ROOTS: '',
      PATH: process.env.PATH
    },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /AGENTMAIL_ATTACHMENT_ROOTS|native/);
});
