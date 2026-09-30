import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = [
  '../README.md',
  '../docs/HEADLESS-MCP.md',
  '../docs/CONFIG.md',
  '../docs/SPEC.md',
  '../tools/hermes-agentmail-mcp.sh'
];

test('MCP wrapper and docs state the security contract', () => {
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /HERMES_HOME/, file);
    assert.match(text, /host paths are rejected/i, file);
    assert.match(text, /metadata only/i, file);
    assert.match(text, /approval is required before `?message_send/i, file);
    assert.match(text, /mail_account_register does not overwrite/i, file);
  }
});
