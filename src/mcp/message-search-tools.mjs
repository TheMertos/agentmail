import * as z from 'zod/v4';
import { normalizeMessageSearch } from '../mail/message-search.mjs';

/**
 * Wrap a JSON tool result.
 * @param {unknown} value Result payload.
 * @returns {{ content: { type: string, text: string }[] }}
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const SAFE_ERRORS = new Set([
  'invalid_account',
  'invalid_cursor',
  'invalid_date',
  'invalid_filter',
  'invalid_flags',
  'invalid_limit',
  'invalid_mailbox',
  'invalid_sort',
  'invalid_status_filter',
  'remote_timeout',
  'search_failed'
]);

/** MCP description for message_search. */
export const messageSearchDescription = 'Search the live IMAP provider for one active account. Does not read a local message mirror and does not fall back to cached messages when the provider fails. When mailboxId and mailboxIds are omitted, only INBOX is searched. Explicit mailboxId or mailboxIds search only those folders and do not discover other folders. Use mailbox_list to discover folders. Keeps message_search(accountId, query, limit) and also accepts subject, from, to, cc, mailboxId, mailboxIds, since/fromDate, before/toDate, isRead, isUnread, hasAttachment, flags/includeFlags, an opaque cursor, sortBy (date or uid), and sortOrder (asc or desc). Dates must be ISO-8601 and are compared in UTC. Limit is bounded from 1 to 200. A stalled connect, lock, or search returns remote_timeout. Returns items, results, nextCursor, hasMore, appliedFilters, and total. Credentials and arbitrary SQL are never accepted or returned.';

/** Zod input schema for message_search. Original accountId, query, and limit stay valid. */
export const messageSearchInputSchema = {
  accountId: z.string().min(1),
  query: z.string().default(''),
  subject: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  mailboxId: z.string().min(1).optional(),
  mailboxIds: z.array(z.string().min(1)).optional(),
  since: z.string().optional(),
  fromDate: z.string().optional(),
  before: z.string().optional(),
  toDate: z.string().optional(),
  isRead: z.boolean().optional(),
  isUnread: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  flags: z.array(z.string()).optional(),
  includeFlags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  sortBy: z.enum(['date', 'uid']).default('date'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
};

/**
 * MCP handler for message_search. Access is limited to the runtime principal's account.
 * Results come only from mailService.searchRemote.
 * @param {{ mailService: { searchRemote: Function }, registry: { assertAccountAccess: Function } }} deps Provider search and principal registry.
 * @returns {(args: object) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageSearchHandler({ mailService, registry }) {
  /**
   * Search live messages visible to the caller principal.
   * @param {object} args Tool arguments.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  return async function messageSearch(args) {
    try {
      registry.assertAccountAccess(args?.accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    let normalized;
    try {
      normalized = normalizeMessageSearch({ ...args });
    } catch (error) {
      const code = SAFE_ERRORS.has(error?.code) ? error.code : 'search_failed';
      return text({ error: code });
    }
    try {
      if (typeof mailService?.searchRemote !== 'function') return text({ error: 'search_failed' });
      return text(await mailService.searchRemote(normalized));
    } catch (error) {
      const code = SAFE_ERRORS.has(error?.code) ? error.code : 'search_failed';
      return text({ error: code });
    }
  };
}
