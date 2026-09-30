import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { simpleParser } = createRequire(import.meta.url)('mailparser');

/** Bound attachment metadata retained in the local mirror. */
export const INCOMING_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 100,
  maxBytes: 25 * 1024 * 1024,
  maxFilenameLength: 255,
  maxContentTypeLength: 255
});

/**
 * Return a bounded string without retaining arbitrary MIME header data.
 * @param {unknown} value Header value.
 * @param {number} maxLength Maximum length.
 * @returns {string}
 */
function boundedString(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

export function sanitizeIncomingAttachmentMetadata(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, INCOMING_ATTACHMENT_LIMITS.maxCount).flatMap((item) => {
    const filename = boundedString(item?.filename, INCOMING_ATTACHMENT_LIMITS.maxFilenameLength);
    const contentType = boundedString(item?.contentType, INCOMING_ATTACHMENT_LIMITS.maxContentTypeLength).toLowerCase();
    const size = Number(item?.size);
    if (!filename) return [];
    const metadata = { filename };
    if (contentType) metadata.contentType = contentType;
    if (Number.isSafeInteger(size) && size >= 0 && size <= INCOMING_ATTACHMENT_LIMITS.maxBytes) metadata.size = size;
    if (typeof item?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256)) metadata.sha256 = item.sha256.toLowerCase();
    return [metadata];
  });
}

/**
 * Extract incoming file parts from a raw message.
 * mailparser's attachments collection contains attachment/inline file parts,
 * while text/plain and text/html alternatives remain body fields.
 * @param {string|Buffer} raw Raw RFC 5322/MIME message.
 * @returns {Promise<Array<{filename: string, contentType: string, size: number, sha256: string}>>} Metadata only.
 */
export async function extractIncomingAttachments(raw) {
  if (raw == null || raw.length === 0) return [];
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  const result = [];
  let totalBytes = 0;
  for (const part of parsed.attachments ?? []) {
    if (!Buffer.isBuffer(part.content)) continue;
    const size = part.content.length;
    if (result.length >= INCOMING_ATTACHMENT_LIMITS.maxCount) break;
    if (size > INCOMING_ATTACHMENT_LIMITS.maxBytes || totalBytes > INCOMING_ATTACHMENT_LIMITS.maxBytes - size) break;
    const filename = boundedString(part.filename, INCOMING_ATTACHMENT_LIMITS.maxFilenameLength);
    const contentType = boundedString(part.contentType, INCOMING_ATTACHMENT_LIMITS.maxContentTypeLength).toLowerCase();
    if (!filename || !contentType) continue;
    result.push({
      filename,
      contentType,
      size,
      sha256: createHash('sha256').update(part.content).digest('hex')
    });
    totalBytes += size;
  }
  return result;
}
