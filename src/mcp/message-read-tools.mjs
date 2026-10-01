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
export const messageReadDescription = 'Read one message by its exact UID and UIDVALIDITY from the live IMAP provider, then set IMAP \\Seen with UID STORE +FLAGS \\Seen. If the provider mark fails, the read fails closed and nothing is written locally. It does not send mail and does not fall back to a local mirror.';

/** Zod input schema for message_read. Only an exact message key is accepted. */
export const messageReadInputSchema = {
  messageKey: z.string().min(1)
};

/**
 * MCP handler for message_read. Content is returned only after provider \\Seen is stored.
 * @param {{ registry: { assertAccountAccess: Function }, mailService: { readAndMarkSeen: Function } }} deps Principal registry and mail service.
 * @returns {(args: { messageKey?: string }) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageReadHandler({ registry, mailService }) {
  /**
   * Fetch one live message and mark it read on the provider.
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
    try {
      if (typeof mailService?.readAndMarkSeen !== 'function') return text({ error: 'provider_unavailable' });
      const message = await mailService.readAndMarkSeen(messageKey);
      return text({ ...message, raw: message.raw });
    } catch (error) {
      return text({ error: redactToolError(error) });
    }
  };
}
