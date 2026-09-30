import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = join(fileURLToPath(new URL('..', import.meta.url)), 'tools', 'hermes-agentmail-mcp.sh');

/**
 * Run the Hermes MCP wrapper with a fake `docker` on PATH.
 * @param {{ instanceName?: string, pathPrefix?: string }} options
 */
function runWrapper({ instanceName, pathPrefix = '' } = {}) {
  const env = { ...process.env, PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH };
  if (instanceName !== undefined) env.HERMES_INSTANCE_NAME = instanceName;
  else delete env.HERMES_INSTANCE_NAME;
  return spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
}

test('hermes MCP wrapper fails when HERMES_INSTANCE_NAME is missing', () => {
  const result = runWrapper();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HERMES_INSTANCE_NAME is required/);
});

test('hermes MCP wrapper fails when HERMES_INSTANCE_NAME is whitespace only', () => {
  const result = runWrapper({ instanceName: '   ' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HERMES_INSTANCE_NAME is required/);
});

test('hermes MCP wrapper injects AGENTMAIL_PRINCIPAL into docker exec', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'agentmail-fake-docker-'));
  const logPath = join(binDir, 'docker-invocation.log');
  const fakeDocker = join(binDir, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" > "${logPath}"
exit 0
`
  );
  chmodSync(fakeDocker, 0o755);

  const result = runWrapper({ instanceName: 'mert', pathPrefix: binDir });
  assert.equal(result.status, 0, result.stderr);

  const invocation = readFileSync(logPath, 'utf8');
  assert.match(invocation, /-e AGENTMAIL_PRINCIPAL=mert/);
  assert.match(invocation, /-e SECRET_FABRIC_PRINCIPAL=mert/);
  assert.match(invocation, /agentmail node src\/mcp\/server\.mjs/);
});
