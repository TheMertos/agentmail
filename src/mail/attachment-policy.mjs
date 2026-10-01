import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

const REJECTED_PATH_KEYS = ['path', 'hostPath', 'filepath', 'sourcePath', 'messagePath', 'attachmentPath'];
const MAIL_CONTENT_KEYS = ['raw', 'mime', 'sourceMessage', 'messageBody', 'body', 'html', 'text'];

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
 * Reject arbitrary path keys and any path carried in mail content.
 * `filePath` is handled separately and only inside an approved root.
 * @param {object} input Tool or validator input.
 */
function assertNoUnapprovedPath(input) {
  if (!input || typeof input !== 'object') throw attachmentError('attachment_invalid');
  for (const key of REJECTED_PATH_KEYS) {
    if (input[key] != null && input[key] !== '') throw attachmentError('attachment_path_rejected');
  }
  for (const key of MAIL_CONTENT_KEYS) {
    if (input[key] != null && input[key] !== '') throw attachmentError('attachment_path_rejected');
  }
}

/**
 * True when `candidate` is a path strictly inside `root`.
 * @param {string} root Absolute directory.
 * @param {string} candidate Absolute path.
 * @returns {boolean}
 */
function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Read a regular file only when every path component stays inside an approved root.
 * @param {string} filePath Absolute caller path.
 * @param {string[]} roots Approved absolute directories.
 * @returns {Buffer}
 */
function readApprovedFile(filePath, roots) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !isAbsolute(filePath)) {
    throw attachmentError('attachment_path_rejected');
  }
  if (!Array.isArray(roots) || roots.length === 0) throw attachmentError('attachment_path_rejected');
  let realRoots;
  try {
    realRoots = roots.map((root) => {
      if (typeof root !== 'string' || !isAbsolute(root)) throw attachmentError('attachment_path_rejected');
      const real = realpathSync(root);
      if (!statSync(real).isDirectory()) throw attachmentError('attachment_path_rejected');
      return real;
    });
  } catch (error) {
    if (error?.code === 'attachment_path_rejected') throw error;
    throw attachmentError('attachment_path_rejected');
  }
  const normalized = resolve(filePath);
  const matched = realRoots.find((root) => isContained(root, normalized));
  if (!matched) throw attachmentError('attachment_path_rejected');
  let current = matched;
  try {
    for (const part of relative(matched, normalized).split(sep)) {
      if (!part || part === '.' || part === '..') throw attachmentError('attachment_path_rejected');
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        const target = realpathSync(current);
        const inside = realRoots.some((root) => target !== root && isContained(root, target));
        if (!inside) throw attachmentError('attachment_path_rejected');
        current = target;
      }
    }
    const fd = openSync(current, 'r');
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw attachmentError('attachment_path_rejected');
      if (info.size <= 0) throw attachmentError('attachment_invalid');
      if (info.size > ATTACHMENT_LIMITS.maxBytes) throw attachmentError('attachment_too_large');
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (String(error?.code ?? '').startsWith('attachment_')) throw error;
    throw attachmentError('attachment_path_rejected');
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
 * Split `AGENTMAIL_ATTACHMENT_ROOTS` on colons.
 * @param {string|undefined} value Colon-separated absolute directories.
 * @returns {string[]}
 */
export function parseAttachmentRoots(value) {
  if (value == null || String(value).trim() === '') return [];
  return String(value).split(':').map((part) => part.trim()).filter(Boolean);
}

/**
 * Validate one uploaded attachment and return its bytes plus public metadata fields.
 * `filePath` is read only from `options.roots`. Other path keys and mail content are rejected.
 * @param {object} input Upload fields.
 * @param {{ roots?: string[] }} [options] Approved absolute roots for `filePath`.
 * @returns {{ filename: string, contentType: string, size: number, sha256: string, content: Buffer }}
 */
export function validateAttachmentUpload(input, options = {}) {
  assertNoUnapprovedPath(input);
  assertSafeFilename(input.filename);
  if (typeof input.contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(input.contentType)) {
    throw attachmentError('attachment_type_rejected');
  }
  assertExtensionMatchesType(input.filename, input.contentType);
  const hasFile = input.filePath != null && input.filePath !== '';
  const hasBytes = input.contentBase64 != null && input.contentBase64 !== '';
  if (hasFile && hasBytes) throw attachmentError('attachment_path_rejected');
  const content = hasFile ? readApprovedFile(input.filePath, options.roots ?? []) : decodeBase64(input.contentBase64);
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
