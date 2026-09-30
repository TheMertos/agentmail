import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = join(fileURLToPath(new URL('..', import.meta.url)), 'tools', 'provision-agentmail-profile.sh');

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
function runProvision(args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of ['SECRET_FABRIC_URL', 'SECRET_FABRIC_API_TOKEN']) {
    if (!(key in env)) delete merged[key];
  }
  return spawnSync('bash', [scriptPath, ...args], { env: merged, encoding: 'utf8' });
}

function fakeDockerComposeOnPath() {
  const binDir = mkdtempSync(join(tmpdir(), 'agentmail-fake-compose-'));
  const fakeDocker = join(binDir, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
if [[ "$1" == "compose" ]]; then
  printf '%s\\n' "$*" >&2
  printf 'AGENTMAIL_PROFILE=%s\\n' "\${AGENTMAIL_PROFILE:-}" >&2
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
`
  );
  chmodSync(fakeDocker, 0o755);
  return binDir;
}

test('provision script rejects invalid profile names', () => {
  const result = runProvision(['bad name'], {
    SECRET_FABRIC_URL: 'https://sf.example',
    SECRET_FABRIC_API_TOKEN: 'token'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid profile name/);
});

test('provision script requires SecretFabric env from operator', () => {
  const noUrl = runProvision(['mert'], { SECRET_FABRIC_API_TOKEN: 'token' });
  assert.notEqual(noUrl.status, 0);
  assert.match(noUrl.stderr, /SECRET_FABRIC_URL is required/);

  const noToken = runProvision(['mert'], { SECRET_FABRIC_URL: 'https://sf.example' });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /SECRET_FABRIC_API_TOKEN is required/);
});

test('provision script starts isolated compose project with profile-specific names', () => {
  const binDir = fakeDockerComposeOnPath();
  const result = runProvision(['mert'], {
    PATH: `${binDir}:${process.env.PATH}`,
    SECRET_FABRIC_URL: 'https://sf.example',
    SECRET_FABRIC_API_TOKEN: 'token'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--project-name agentmail-mert/);
  assert.match(result.stderr, /up -d --build/);
  assert.match(result.stderr, /AGENTMAIL_PROFILE=mert/);
});
