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

/** MCP description for message_mark_read. */
export const messageMarkReadDescription = 'Set the provider IMAP \\Seen flag for one exact messageKey. Performs UID STORE +FLAGS \\Seen only for that accessible account, mailbox, and message. Passive sync, IDLE, search, indexing, attachment extraction, and message_read do not write \\Seen. It does not send mail.';

/** Zod input schema for message_mark_read. Only an exact message key is accepted. */
export const messageMarkReadInputSchema = {
  messageKey: z.string().min(1)
};

/**
 * MCP handler for message_mark_read. Missing keys and inaccessible accounts fail closed.
 * @param {{ store: object, registry: { assertAccountAccess: Function }, mailService: { markRead: Function } }} deps Store, principal registry, and mail service.
 * @returns {(args: { messageKey?: string }) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageMarkReadHandler({ store, registry, mailService }) {
  /**
   * Mark one mirrored message read on the provider.
   * @param {{ messageKey?: string }} args Tool input.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  return async function messageMarkRead({ messageKey } = {}) {
    if (typeof messageKey !== 'string' || messageKey.trim() === '') return text({ error: 'message_key_required' });
    const accountId = messageKey.split(':')[0];
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    try {
      return text(await mailService.markRead(messageKey, store));
    } catch (error) {
      return text({ error: redactToolError(error) });
    }
  };
}
