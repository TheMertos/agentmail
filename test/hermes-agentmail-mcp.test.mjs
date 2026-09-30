import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(repoRoot, 'tools', 'hermes-agentmail-mcp.sh');

/**
 * Run the Hermes MCP wrapper with a fake `docker` on PATH.
 * @param {{ hermesHome?: string, pathPrefix?: string, fakeDockerEnv?: Record<string, string> }} options
 */
function runWrapper({ hermesHome, pathPrefix = '', fakeDockerEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    ...fakeDockerEnv
  };
  delete env.HERMES_INSTANCE_NAME;
  if (hermesHome !== undefined) env.HERMES_HOME = hermesHome;
  else delete env.HERMES_HOME;
  return spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
}

/**
 * @param {{ containerInspectFails?: boolean }} options
 */
function fakeDockerBin({ containerInspectFails = false } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'agentmail-fake-docker-'));
  const logPath = join(binDir, 'docker-invocation.log');
  const fakeDocker = join(binDir, 'docker');
  const inspectExit = containerInspectFails ? 1 : 0;
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
log="${logPath}"
if [[ "$1" == "container" && "$2" == "inspect" ]]; then
  exit ${inspectExit}
fi
if [[ "$1" == "exec" ]]; then
  printf '%s\\n' "$*" > "$log"
  exit 0
fi
printf '%s\\n' "$*" > "$log"
exit 0
`
  );
  chmodSync(fakeDocker, 0o755);
  return { binDir, logPath };
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

test('hermes MCP wrapper fails when profile container is missing', () => {
  const { binDir } = fakeDockerBin({ containerInspectFails: true });
  const result = runWrapper({
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AgentMail container not found: agentmail-mert/);
  assert.match(result.stderr, /provision-agentmail-profile/);
});

test('hermes MCP wrapper targets profile-derived container and principal', () => {
  const { binDir, logPath } = fakeDockerBin();
  const result = runWrapper({ hermesHome: '/home/user/.hermes/profiles/mert', pathPrefix: binDir });
  assert.equal(result.status, 0, result.stderr);

  const invocation = readFileSync(logPath, 'utf8');
  assert.match(invocation, /-e AGENTMAIL_PRINCIPAL=mert/);
  assert.match(invocation, /-e SECRET_FABRIC_PRINCIPAL=mert/);
  assert.match(invocation, /agentmail-mert node src\/mcp\/server\.mjs/);
});

test('hermes MCP wrapper uses agentmail-default for default Hermes home', () => {
  const { binDir, logPath } = fakeDockerBin();
  const result = runWrapper({ hermesHome: '/home/user/.hermes', pathPrefix: binDir });
  assert.equal(result.status, 0, result.stderr);

  const invocation = readFileSync(logPath, 'utf8');
  assert.match(invocation, /-e AGENTMAIL_PRINCIPAL=default/);
  assert.match(invocation, /-e SECRET_FABRIC_PRINCIPAL=default/);
  assert.match(invocation, /agentmail-default node src\/mcp\/server\.mjs/);
});

test('hermes MCP wrapper trims HERMES_HOME and accepts trailing slash on default home', () => {
  const { binDir, logPath } = fakeDockerBin();
  const result = runWrapper({ hermesHome: '  /home/user/.hermes/  ', pathPrefix: binDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /agentmail-default/);
});
