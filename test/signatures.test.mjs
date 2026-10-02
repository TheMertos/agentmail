import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeSignatureParts, loadAiFooter, sanitizeSignatureHtml } from '../src/core/signatures.mjs';

const AI_FOOTER_HTML_PATH = '/home/mert/mail/sent_by_ai.html';

test('sanitizes executable HTML but preserves email-safe tables and inline styles', () => {
  const html = '<table style="border:1px solid #ccc"><tr><td style="color:#005ea6">Hello</td></tr></table><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
  const safe = sanitizeSignatureHtml(html);
  assert.equal(safe.includes('<table'), true);
  assert.equal(safe.includes('<td'), true);
  assert.equal(safe.includes('border:1px solid #ccc'), true);
  assert.equal(safe.includes('color:#005ea6'), true);
  assert.equal(safe.includes('<script'), false);
  assert.equal(safe.includes('javascript:'), false);
});

test('loads the sent_by_ai HTML footer and its plain-text equivalent', () => {
  const source = readFileSync(AI_FOOTER_HTML_PATH, 'utf8');
  const footer = loadAiFooter();
  assert.equal(footer.html, sanitizeSignatureHtml(source));
  assert.equal(footer.text, '[ SENT BY AI AGENT ]');
  assert.equal((footer.html.match(/\[ SENT BY AI AGENT \]/g) ?? []).length, 1);
  assert.equal(footer.html.includes('<script'), false);
});

test('renders HTML and plain-text signature exactly once', () => {
  const parts = composeSignatureParts({
    html: '<p><strong>Mert Yagci</strong></p>',
    text: 'Mert Yagci'
  });
  assert.equal(parts.html, '<p><strong>Mert Yagci</strong></p>');
  assert.equal(parts.text, 'Mert Yagci');
});
