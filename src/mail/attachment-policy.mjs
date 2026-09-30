import { createHash } from 'node:crypto';

/** Per-file, count, and total-byte caps for staged outgoing attachments. */
export const ATTACHMENT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxCount: 10,
  maxTotalBytes: 25 * 1024 * 1024
});

/** Content types accepted for outgoing attachments. */
export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain'
]);

const EXECUTABLE_EXTENSIONS = new Set([
  '.apk', '.app', '.bash', '.bat', '.bin', '.cmd', '.cjs', '.com', '.deb', '.dll',
  '.dmg', '.elf', '.exe', '.hta', '.jar', '.js', '.mjs', '.msi', '.ps1', '.rpm',
  '.scr', '.sh', '.so', '.vbs', '.wsf'
]);

const CREDENTIAL_NAME = [
  /(^|[._-])(credentials?|secrets?)(\.|$)/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /aws[_-]?credentials/i,
  /\.netrc$/i,
  /^(passwd|shadow|authorized_keys|known_hosts)$/i
];

const PATH_KEYS = ['path', 'filePath', 'hostPath', 'filepath', 'sourcePath'];

/** Filename extension to the single content type it may declare. */
const EXTENSION_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.odt', 'application/vnd.oasis.opendocument.text']
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Create a fail-closed attachment error whose message is the stable code.
 * @param {string} code Error code.
 * @returns {Error}
 */
export function attachmentError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Reject host filesystem paths. Upload accepts bytes only.
 * @param {object} input Tool or validator input.
 */
function assertNoHostPath(input) {
  if (!input || typeof input !== 'object') throw attachmentError('attachment_invalid');
  for (const key of PATH_KEYS) {
    if (input[key] != null && input[key] !== '') throw attachmentError('attachment_path_rejected');
  }
}

/**
 * Reject traversal, executables, and credential-like filenames.
 * @param {string} filename Single path segment.
 */
function assertSafeFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 180) {
    throw attachmentError('attachment_name_rejected');
  }
  if (filename.normalize('NFKC') !== filename) throw attachmentError('attachment_name_rejected');
  let decoded = filename;
  try {
    decoded = decodeURIComponent(filename);
  } catch {
    throw attachmentError('attachment_name_rejected');
  }
  if (decoded !== filename || /[\\/\0\r\n\t"';]/.test(filename) || filename.includes('..')) {
    throw attachmentError('attachment_name_rejected');
  }
  if (filename.startsWith('.') || filename.endsWith('.') || filename.endsWith(' ')) {
    throw attachmentError('attachment_name_rejected');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(filename)) throw attachmentError('attachment_name_rejected');
  const lower = filename.toLowerCase();
  const extensions = lower.includes('.') ? lower.split('.').slice(1).map((part) => `.${part}`) : [];
  if (extensions.some((extension) => EXECUTABLE_EXTENSIONS.has(extension))) {
    throw attachmentError('attachment_name_rejected');
  }
  if (CREDENTIAL_NAME.some((pattern) => pattern.test(lower))) throw attachmentError('attachment_name_rejected');
}

/**
 * Decode canonical base64 without accepting a filesystem path.
 * @param {string} value Base64 payload.
 * @returns {Buffer}
 */
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) throw attachmentError('attachment_invalid');
  const maxEncoded = Math.ceil(ATTACHMENT_LIMITS.maxBytes / 3) * 4 + 4;
  if (value.length > maxEncoded + 1024) throw attachmentError('attachment_too_large');
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw attachmentError('attachment_invalid');
  }
  const content = Buffer.from(compact, 'base64');
  if (content.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw attachmentError('attachment_invalid');
  }
  return content;
}

/**
 * Reject PEM private keys, cloud tokens, and dotenv-style secret files.
 * @param {Buffer} content Decoded bytes.
 * @param {string} contentType Allowed media type.
 */
function assertNoPlaintextSecret(content, contentType) {
  const latin = content.toString('latin1');
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(latin) || /AKIA[0-9A-Z]{16}/.test(latin)) {
    throw attachmentError('attachment_secret_rejected');
  }
  if (contentType.startsWith('text/') && /^(?:password|passwd|secret|api[_-]?key|private[_-]?key|token)\s*[:=]/im.test(content.toString('utf8'))) {
    throw attachmentError('attachment_secret_rejected');
  }
}

/**
 * True when the buffer begins with the given bytes.
 * @param {Buffer} content Decoded bytes.
 * @param {Buffer|string} prefix Expected prefix.
 * @returns {boolean}
 */
function startsWithBytes(content, prefix) {
  const expected = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  return content.length >= expected.length && content.subarray(0, expected.length).equals(expected);
}

/**
 * Require the filename extension to be the declared content type.
 * @param {string} filename Single path segment.
 * @param {string} contentType Allowed media type.
 */
function assertExtensionMatchesType(filename, contentType) {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot).toLowerCase() : '';
  if (EXTENSION_TYPES.get(extension) !== contentType) throw attachmentError('attachment_type_rejected');
}

/**
 * Reject binary and non-UTF-8 payloads declared as text.
 * @param {Buffer} content Decoded bytes.
 */
function assertTextBytes(content) {
  if (content.includes(0)) throw attachmentError('attachment_type_rejected');
  const binaryPrefixes = [
    Buffer.from('%PDF-'),
    PNG_SIGNATURE,
    Buffer.from([0xff, 0xd8, 0xff]),
    ZIP_LOCAL,
    Buffer.from('MZ'),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from('GIF87a'),
    Buffer.from('GIF89a'),
    OLE_SIGNATURE
  ];
  if (binaryPrefixes.some((prefix) => startsWithBytes(content, prefix))) throw attachmentError('attachment_type_rejected');
  if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content)) throw attachmentError('attachment_type_rejected');
  for (const byte of content) {
    const allowed = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f) || byte >= 0x80;
    if (!allowed) throw attachmentError('attachment_type_rejected');
  }
}

/**
 * Require magic bytes that match the declared content type.
 * PDF bytes must begin with %PDF-.
 * @param {Buffer} content Decoded bytes.
 * @param {string} contentType Allowed media type.
 */
function assertMagic(content, contentType) {
  if (contentType === 'application/pdf') {
    if (!startsWithBytes(content, '%PDF-')) throw attachmentError('attachment_type_rejected');
    return;
  }
  if (contentType === 'image/png') {
    if (!startsWithBytes(content, PNG_SIGNATURE)) throw attachmentError('attachment_type_rejected');
    return;
  }
  if (contentType === 'image/jpeg') {
    if (!(content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)) {
      throw attachmentError('attachment_type_rejected');
    }
    return;
  }
  if (contentType === 'image/gif') {
    if (!(startsWithBytes(content, 'GIF87a') || startsWithBytes(content, 'GIF89a'))) {
      throw attachmentError('attachment_type_rejected');
    }
    return;
  }
  if (contentType === 'image/webp') {
    if (!(startsWithBytes(content, 'RIFF') && content.length >= 12 && content.subarray(8, 12).toString('latin1') === 'WEBP')) {
      throw attachmentError('attachment_type_rejected');
    }
    return;
  }
  if (contentType === 'text/plain' || contentType === 'text/csv') {
    assertTextBytes(content);
    return;
  }
  if (contentType.includes('openxmlformats') || contentType.includes('oasis.opendocument')) {
    if (!startsWithBytes(content, ZIP_LOCAL)) throw attachmentError('attachment_type_rejected');
    return;
  }
  if (contentType === 'application/msword') {
    if (!startsWithBytes(content, OLE_SIGNATURE)) throw attachmentError('attachment_type_rejected');
    return;
  }
  throw attachmentError('attachment_type_rejected');
}

/**
 * Validate one uploaded attachment and return its bytes plus public metadata fields.
 * @param {object} input Upload fields. `path` is rejected and never read.
 * @returns {{ filename: string, contentType: string, size: number, sha256: string, content: Buffer }}
 */
export function validateAttachmentUpload(input) {
  assertNoHostPath(input);
  assertSafeFilename(input.filename);
  if (typeof input.contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(input.contentType)) {
    throw attachmentError('attachment_type_rejected');
  }
  assertExtensionMatchesType(input.filename, input.contentType);
  const content = decodeBase64(input.contentBase64);
  if (content.length === 0) throw attachmentError('attachment_invalid');
  if (content.length > ATTACHMENT_LIMITS.maxBytes) throw attachmentError('attachment_too_large');
  assertNoPlaintextSecret(content, input.contentType);
  assertMagic(content, input.contentType);
  return {
    filename: input.filename,
    contentType: input.contentType,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    content
  };
}

/**
 * Enforce count and aggregate size for a set of attachment metadata.
 * @param {Array<{ size: number }>} attachments Attachment metadata.
 */
export function assertAttachmentSetLimits(attachments) {
  if (!Array.isArray(attachments)) throw attachmentError('attachment_invalid');
  if (attachments.length > ATTACHMENT_LIMITS.maxCount) throw attachmentError('attachment_limit_exceeded');
  let total = 0;
  for (const item of attachments) {
    const size = item?.size;
    if (!Number.isInteger(size) || size < 0) throw attachmentError('attachment_invalid');
    if (size > ATTACHMENT_LIMITS.maxBytes) throw attachmentError('attachment_too_large');
    total += size;
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) throw attachmentError('attachment_too_large');
  }
}
