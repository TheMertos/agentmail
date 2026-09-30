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

/** MCP description for message_read. */
export const messageReadDescription = 'Read one complete locally mirrored message by its exact message key, then set IMAP \\Seen with UID STORE +FLAGS \\Seen. If the provider mark fails, the read fails closed and local flags stay unchanged. It does not send mail.';

/** Zod input schema for message_read. Only an exact message key is accepted. */
export const messageReadInputSchema = {
  messageKey: z.string().min(1)
};

/**
 * MCP handler for message_read. Content is returned only after provider \\Seen is stored.
 * @param {{ store: object, registry: { assertAccountAccess: Function }, mailService: { markRead: Function } }} deps Store, principal registry, and mail service.
 * @returns {(args: { messageKey?: string }) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageReadHandler({ store, registry, mailService }) {
  /**
   * Resolve one mirrored message and mark it read on the provider.
   * @param {{ messageKey?: string }} args Tool input.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  return async function messageRead({ messageKey } = {}) {
    if (typeof messageKey !== 'string' || messageKey.trim() === '') return text({ error: 'message_key_required' });
    const accountId = messageKey.split(':')[0];
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    await store.backfillMessageAttachments(messageKey);
    const message = store.getMessage(messageKey);
    if (!message) return text({ error: 'source_message_not_found' });
    try {
      await mailService.markRead(messageKey, store);
    } catch (error) {
      return text({ error: redactToolError(error) });
    }
    const marked = store.getMessage(messageKey);
    if (!marked) return text({ error: 'source_message_not_found' });
    return text({ ...marked, raw: marked.raw });
  };
}
