import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAttachmentUpload } from '../src/mail/attachment-policy.mjs';
import { createAttachmentHandlers } from '../src/mcp/attachment-tools.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/**
 * Create an approved root containing a PDF.
 * @returns {{ root: string, filePath: string }}
 */
function approvedPdf() {
  const root = mkdtempSync(join(tmpdir(), 'agentmail-allow-'));
  const filePath = join(root, 'Mert-Yagci-CV.pdf');
  writeFileSync(filePath, PDF);
  return { root, filePath };
}

test('filePath inside an approved root is staged and bound by sha256', () => {
  const { root, filePath } = approvedPdf();
  const validated = validateAttachmentUpload({
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    filePath
  }, { roots: [root] });
  const sha256 = createHash('sha256').update(PDF).digest('hex');
  assert.equal(validated.sha256, sha256);
  assert.equal(validated.size, PDF.length);
  assert.equal(validated.content.equals(PDF), true);

  const dir = mkdtempSync(join(tmpdir(), 'agentmail-allow-db-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register({
    id: 'gmail',
    email: 'mert@example.test',
    provider: 'gmail',
    secretRef: 'resource-gmail',
    connection: { host: 'imap.gmail.com' }
  });
  const handlers = createAttachmentHandlers({ store, registry, attachmentRoots: [root] });
  const staged = JSON.parse(handlers.attachmentUpload({
    accountId: 'gmail',
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    filePath
  }).content[0].text);
  const preview = handlers.previewAttachments('gmail', [{ id: staged.id }]);
  assert.equal(preview[0].sha256, sha256);
  assert.equal(JSON.stringify(preview).includes(filePath), false);
  store.close();
});

test('filePath rejects arbitrary paths, symlink escapes, and mail content', () => {
  const { root, filePath } = approvedPdf();
  const outside = mkdtempSync(join(tmpdir(), 'agentmail-outside-'));
  const outsideFile = join(outside, 'secret.pdf');
  writeFileSync(outsideFile, PDF);
  const link = join(root, 'escape.pdf');
  symlinkSync(outsideFile, link);
  const dirLink = join(root, 'subdir');
  symlinkSync(outside, dirLink);
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'ok.pdf'), PDF);

  const cases = [
    { filePath: outsideFile, code: 'attachment_path_rejected' },
    { filePath: link, code: 'attachment_path_rejected' },
    { filePath: join(dirLink, 'secret.pdf'), code: 'attachment_path_rejected' },
    { filePath: '/etc/passwd', code: 'attachment_path_rejected' },
    { filePath, path: filePath, code: 'attachment_path_rejected' },
    { filePath, raw: `see ${filePath}`, code: 'attachment_path_rejected' },
    { filePath, contentBase64: PDF.toString('base64'), code: 'attachment_path_rejected' },
    { filePath: root, code: 'attachment_path_rejected' }
  ];
  for (const input of cases) {
    assert.throws(() => validateAttachmentUpload({
      filename: 'Mert-Yagci-CV.pdf',
      contentType: 'application/pdf',
      ...input
    }, { roots: [root] }), (error) => error.code === input.code, JSON.stringify(input));
  }

  assert.throws(() => validateAttachmentUpload({
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    filePath
  }, { roots: [] }), /attachment_path_rejected/);

  const spoof = join(root, 'spoof.pdf');
  writeFileSync(spoof, Buffer.from('not-a-pdf'));
  assert.throws(() => validateAttachmentUpload({
    filename: 'spoof.pdf',
    contentType: 'application/pdf',
    filePath: spoof
  }, { roots: [root] }), (error) => error.code === 'attachment_type_rejected');
});
