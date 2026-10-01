import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(repoRoot, 'tools', 'hermes-agentmail-mcp.sh');

/**
 * Run the Hermes MCP wrapper.
 * @param {{ hermesHome?: string, pathPrefix?: string, extraEnv?: Record<string, string> }} options
 */
function runWrapper({ hermesHome, pathPrefix = '', extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    ...extraEnv
  };
  delete env.HERMES_INSTANCE_NAME;
  if (hermesHome !== undefined) env.HERMES_HOME = hermesHome;
  else delete env.HERMES_HOME;
  return spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
}

/**
 * Place a fake node and a docker binary that fails if invoked.
 * @returns {{ binDir: string }}
 */
function fakeNodeBin() {
  const binDir = mkdtempSync(join(tmpdir(), 'agentmail-fake-node-'));
  const fakeNode = join(binDir, 'node');
  const fakeDocker = join(binDir, 'docker');
  writeFileSync(fakeNode, '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(fakeDocker, '#!/usr/bin/env bash\necho "docker must not be called" >&2\nexit 1\n');
  chmodSync(fakeNode, 0o755);
  chmodSync(fakeDocker, 0o755);
  return { binDir };
}

test('hermes MCP wrapper fails when HERMES_HOME is missing', () => {
  const result = runWrapper();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HERMES_HOME is required/);
});

test('hermes MCP wrapper fails when HERMES_HOME is whitespace only', () => {
  const result = runWrapper({ hermesHome: '   ' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HERMES_HOME is required/);
});

test('hermes MCP wrapper fails for ambiguous HERMES_HOME paths', () => {
  for (const hermesHome of [
    '/tmp/not-hermes',
    '/home/user/.hermes/profiles',
    '/home/user/.hermes/profiles/a/b',
    '/home/user/.hermes/other'
  ]) {
    const result = runWrapper({ hermesHome });
    assert.notEqual(result.status, 0, hermesHome);
    assert.match(result.stderr, /cannot derive principal/);
  }
});

test('hermes MCP wrapper rejects invalid derived principal characters', () => {
  const result = runWrapper({ hermesHome: '/home/user/.hermes/profiles/bad name' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid characters/);
});

test('hermes MCP wrapper does not require a Docker container', () => {
  const { binDir } = fakeNodeBin();
  const home = mkdtempSync(join(tmpdir(), 'agentmail-hermes-home-'));
  const result = runWrapper({
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    extraEnv: {
      HOME: home,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /container not found/);
});
