/** Address shape shared by To, Cc, and Bcc. Display names and header injection are rejected. */
const RECIPIENT_ADDRESS = /^(?=.{3,254}$)[A-Za-z0-9](?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Build the stable recipient validation error.
 * @returns {Error & { code: string }}
 */
function recipientError() {
  const error = new Error('recipients_invalid');
  error.code = 'recipients_invalid';
  return error;
}

/**
 * Normalize one recipient list with the same rules for To, Cc, and Bcc.
 * A missing list is empty. Each address is trimmed and must be a bare mailbox.
 * @param {unknown} value Raw recipient list.
 * @param {{ required?: boolean }} [options] Set required when the list must be non-empty.
 * @returns {string[]} Trimmed addresses in caller order.
 */
export function normalizeRecipientList(value, { required = false } = {}) {
  if (value == null) {
    if (required) throw recipientError();
    return [];
  }
  if (!Array.isArray(value)) throw recipientError();
  const normalized = value.map((item) => {
    if (typeof item !== 'string' || /[\r\n]/.test(item)) throw recipientError();
    const address = item.trim();
    if (!RECIPIENT_ADDRESS.test(address)) throw recipientError();
    return address;
  });
  if (required && normalized.length === 0) throw recipientError();
  return normalized;
}

/**
 * Compare two recipient lists in order.
 * Missing lists match an empty list.
 * @param {string[]|undefined|null} left Approved or preview addresses.
 * @param {string[]|undefined|null} right Requested addresses.
 * @returns {boolean}
 */
export function sameRecipientList(left, right) {
  const approved = left ?? [];
  const requested = right ?? [];
  if (approved.length !== requested.length) return false;
  return approved.every((address, index) => address === requested[index]);
}
