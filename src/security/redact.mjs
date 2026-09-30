const ASSIGNMENT = /((?:password|passwd|secret|api[_-]?key|private[_-]?key|token)\s*[:=]\s*)(\S+)/gi;
const BEARER = /(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi;
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const LONG_BASE64 = /(?<![A-Za-z0-9+/])(?![a-f0-9]{64}(?![A-Za-z0-9+/]))[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/])/g;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DROPPED_KEYS = new Set([
  'password', 'pass', 'secret', 'token', 'accesstoken', 'refreshtoken', 'privatekey',
  'contentbase64', 'content', 'credentials', 'secretref', 'authorization', 'apikey'
]);

/**
 * Remove passwords, tokens, private keys, and attachment base64 from a log or error string.
 * A 64-character sha256 hex digest is preserved.
 * @param {string} value Untrusted text.
 * @returns {string}
 */
export function redactSensitiveText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(PEM, '[redacted]')
    .replace(ASSIGNMENT, '$1[redacted]')
    .replace(BEARER, '$1[redacted]')
    .replace(AWS_KEY, '[redacted]')
    .replace(LONG_BASE64, '[redacted]');
}

/**
 * Return a stable error code, or redacted text that cannot carry the original secret.
 * @param {unknown} error Caught error.
 * @returns {string}
 */
export function redactToolError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  const message = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
  if (SAFE_CODE.test(message)) return message;
  return 'request_rejected';
}

/**
 * True when a result key would expose credentials or attachment bytes.
 * @param {string} key Object key.
 * @returns {boolean}
 */
function dropsKey(key) {
  if (key === 'hasCredentialReference') return false;
  const compact = key.replace(/[_-]/g, '').toLowerCase();
  return DROPPED_KEYS.has(key.toLowerCase()) || DROPPED_KEYS.has(compact);
}

/**
 * Copy a tool result without credential fields, attachment bytes, or embedded secrets.
 * @param {unknown} value Tool result.
 * @returns {unknown}
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      if (dropsKey(key)) continue;
      cleaned[key] = redactValue(nested);
    }
    return cleaned;
  }
  return value;
}
