import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveText, redactToolError, redactValue } from '../src/security/redact.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('redaction removes passwords, tokens, PEM blocks, and attachment base64 from text', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIBsecretvalue\n-----END PRIVATE KEY-----';
  const encoded = PDF.toString('base64');
  const raw = [
    'smtp failed password=hunter2',
    'token: super-secret-token',
    'api_key=sk-live-123',
    'Authorization: Bearer eyJhbGciOi.secret.sig',
    'AKIAIOSFODNN7EXAMPLE',
    pem,
    encoded
  ].join('\n');
  const redacted = redactSensitiveText(raw);
  for (const secret of ['hunter2', 'super-secret-token', 'sk-live-123', 'eyJhbGciOi.secret.sig', 'AKIAIOSFODNN7EXAMPLE', 'MIIBsecretvalue', encoded]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /\[redacted\]/);
});

test('tool errors and results drop credential-like values without erasing sha256 metadata', () => {
  const encoded = PDF.toString('base64');
  const sha = 'a'.repeat(64);
  assert.equal(redactToolError(Object.assign(new Error(`AUTH password=${encoded}`), { code: 'smtp_not_accepted' })), 'smtp_not_accepted');
  const leaked = redactToolError(new Error(`AUTH password=hunter2 body=${encoded}`));
  assert.equal(leaked.includes('hunter2'), false);
  assert.equal(leaked.includes(encoded), false);
  const cleaned = redactValue({
    status: 'sent_and_saved',
    sha256: sha,
    password: 'hunter2',
    secretRef: 'resource-gmail',
    contentBase64: encoded,
    note: `see ${encoded}`
  });
  assert.equal(cleaned.sha256, sha);
  assert.equal(cleaned.password, undefined);
  assert.equal(cleaned.secretRef, undefined);
  assert.equal(cleaned.contentBase64, undefined);
  assert.equal(JSON.stringify(cleaned).includes('hunter2'), false);
  assert.equal(JSON.stringify(cleaned).includes(encoded), false);
  assert.equal(JSON.stringify(cleaned).includes('resource-gmail'), false);
});
