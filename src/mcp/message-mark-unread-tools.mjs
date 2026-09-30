import * as z from 'zod/v4';
import { redactToolError } from '../security/redact.mjs';

/**
 * Wrap a JSON tool result.
 * @param {unknown} value Result payload.
 * @returns {{ content: { type: string, text: string }[] }}
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** MCP description for message_mark_unread. */
export const messageMarkUnreadDescription = 'Clear the provider IMAP \\Seen flag for one exact messageKey. Performs UID STORE -FLAGS \\Seen only when explicitly called for that accessible account, mailbox, UID, and UIDVALIDITY. Passive sync, IDLE, search, flags reconciliation, attachment extraction, and header-only reads do not STORE flags. It does not send mail.';

/** Zod input schema for message_mark_unread. Only an exact message key is accepted. */
export const messageMarkUnreadInputSchema = {
  messageKey: z.string().min(1)
};

/**
 * MCP handler for message_mark_unread. Missing keys and inaccessible accounts fail closed.
 * @param {{ store: object, registry: { assertAccountAccess: Function }, mailService: { markUnread: Function } }} deps Store, principal registry, and mail service.
 * @returns {(args: { messageKey?: string }) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageMarkUnreadHandler({ store, registry, mailService }) {
  /**
   * Mark one mirrored message unread on the provider.
   * @param {{ messageKey?: string }} args Tool input.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  return async function messageMarkUnread({ messageKey } = {}) {
    if (typeof messageKey !== 'string' || messageKey.trim() === '') return text({ error: 'message_key_required' });
    const accountId = messageKey.split(':')[0];
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    try {
      return text(await mailService.markUnread(messageKey, store));
    } catch (error) {
      return text({ error: redactToolError(error) });
    }
  };
}
