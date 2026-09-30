import { createHash } from 'node:crypto';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const PARTY_FIELDS = new Set(['from', 'to', 'cc']);

/** Canonical UTC instant expression for mirror dates stored as ISO-8601. */
const UTC_INSTANT_SQL = `CASE
  WHEN internal_date GLOB '????-??-??T??:??:??.???Z' THEN internal_date
  WHEN internal_date GLOB '????-??-??T??:??:??Z' THEN substr(internal_date, 1, 19) || '.000Z'
  WHEN internal_date GLOB '????-??-??T??:??:??.*Z' THEN substr(internal_date, 1, 19) || '.' || substr(replace(substr(internal_date, 21), 'Z', '') || '000', 1, 3) || 'Z'
  ELSE NULL
END`;

const SORT_SQL = {
  date: `COALESCE((${UTC_INSTANT_SQL}), '')`,
  uid: 'uid'
};

/**
 * Search input that cannot be applied safely.
 */
export class MessageSearchError extends Error {
  /**
   * @param {string} code Stable error code.
   */
  constructor(code) {
    super(code);
    this.name = 'MessageSearchError';
    this.code = code;
  }
}

/**
 * Normalize search criteria. Dates become UTC instants. Unknown fields are ignored.
 * @param {object} input Criteria object.
 * @param {{ legacyLimit?: boolean }} [options] Clamp the positional limit instead of rejecting it.
 * @returns {object} Normalized criteria.
 */
export function normalizeMessageSearch(input, options = {}) {
  if (!input || typeof input !== 'object' || typeof input.accountId !== 'string' || input.accountId.length === 0) {
    throw new MessageSearchError('invalid_account');
  }
  const isRead = optionalBoolean(input.isRead);
  const isUnread = optionalBoolean(input.isUnread);
  if (isRead === true && isUnread === true) throw new MessageSearchError('invalid_status_filter');
  if (isRead === false && isUnread === false) throw new MessageSearchError('invalid_status_filter');
  const since = oneInstant(input.since, input.fromDate);
  const before = oneInstant(input.before, input.toDate);
  if (since && before && since >= before) throw new MessageSearchError('invalid_date');
  return {
    accountId: input.accountId,
    query: optionalText(input.query),
    subject: optionalText(input.subject),
    from: optionalText(input.from),
    to: optionalText(input.to),
    cc: optionalText(input.cc),
    mailboxIds: normalizeMailboxes(input.mailboxId, input.mailboxIds),
    since,
    before,
    isRead,
    isUnread,
    hasAttachment: optionalBoolean(input.hasAttachment),
    flags: normalizeFlags(input.flags, input.includeFlags),
    limit: normalizeLimit(input.limit, options.legacyLimit === true),
    sortBy: normalizeChoice(input.sortBy, ['date', 'uid'], 'date'),
    sortOrder: normalizeChoice(input.sortOrder, ['asc', 'desc'], 'desc'),
    cursor: normalizeCursor(input.cursor)
  };
}

/**
 * Build a parameterized list query and a matching count query.
 * @param {object} normalized Output of normalizeMessageSearch.
 * @returns {{ listSql: string, listParams: unknown[], countSql: string, countParams: unknown[] }}
 */
export function compileMessageSearch(normalized) {
  const where = ['account_id = ?'];
  const params = [normalized.accountId];
  if (normalized.query) addLike(where, params, `lower(COALESCE(raw_mime, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(envelope_json, '')) LIKE ? ESCAPE '\\'`, normalized.query, 2);
  if (normalized.subject) addLike(where, params, subjectPredicate(), normalized.subject, 1);
  if (normalized.from) addParty(where, params, 'from', normalized.from);
  if (normalized.to) addParty(where, params, 'to', normalized.to);
  if (normalized.cc) addParty(where, params, 'cc', normalized.cc);
  if (normalized.mailboxIds.length) {
    where.push(`mailbox_id IN (${normalized.mailboxIds.map(() => '?').join(', ')})`);
    params.push(...normalized.mailboxIds);
  }
  if (normalized.since) {
    where.push(`(${UTC_INSTANT_SQL}) >= ?`);
    params.push(normalized.since);
  }
  if (normalized.before) {
    where.push(`(${UTC_INSTANT_SQL}) < ?`);
    params.push(normalized.before);
  }
  if (normalized.isRead === true || normalized.isUnread === false) where.push(seenPredicate());
  if (normalized.isUnread === true || normalized.isRead === false) where.push(`NOT (${seenPredicate()})`);
  if (normalized.hasAttachment === true) where.push(attachmentPredicate());
  if (normalized.hasAttachment === false) where.push(`NOT ${attachmentPredicate()}`);
  for (const flag of normalized.flags) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(flags_json) THEN flags_json ELSE '[]' END) AS flag
      WHERE lower(flag.value) = lower(?)
    )`);
    params.push(flag);
  }
  const listWhere = [...where];
  const listParams = [...params];
  if (normalized.cursor) {
    const cursor = decodeCursor(normalized.cursor, normalized);
    const expr = SORT_SQL[normalized.sortBy];
    const op = normalized.sortOrder === 'asc' ? '>' : '<';
    listWhere.push(`(${expr} ${op} ? OR (${expr} = ? AND message_key ${op} ?))`);
    listParams.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }
  const direction = normalized.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const expr = SORT_SQL[normalized.sortBy];
  const listSql = `SELECT message_key, account_id, mailbox_id, uid, uid_validity, internal_date, flags_json, envelope_json, ${SORT_SQL.date} AS sort_date
    FROM messages WHERE ${listWhere.join(' AND ')}
    ORDER BY ${expr} ${direction}, message_key ${direction} LIMIT ?`;
  listParams.push(normalized.limit + 1);
  return {
    listSql,
    listParams,
    countSql: `SELECT COUNT(*) AS total FROM messages WHERE ${where.join(' AND ')}`,
    countParams: params
  };
}

/**
 * Shape one page from limit+1 rows.
 * @param {{ rows: object[], total: number, normalized: object }} page Query page.
 * @returns {object} Envelope with items, results, nextCursor, hasMore, appliedFilters, and total.
 */
export function buildMessageSearchPage({ rows, total, normalized }) {
  const hasMore = rows.length > normalized.limit;
  const pageRows = hasMore ? rows.slice(0, normalized.limit) : rows;
  const items = pageRows.map(mapSearchRow);
  return {
    items,
    results: items,
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1], normalized) : null,
    hasMore,
    appliedFilters: appliedFilters(normalized),
    total
  };
}

/**
 * Parse JSON stored on a message row, falling back when the text is not valid JSON.
 * @param {string|null|undefined} value Raw JSON text.
 * @param {unknown} fallback Value used when parsing fails or the shape is wrong.
 * @returns {unknown}
 */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

/**
 * Map one SQL row to the public message summary.
 * @param {object} row SQLite row.
 * @returns {object}
 */
function mapSearchRow(row) {
  return {
    key: row.message_key,
    accountId: row.account_id,
    mailboxId: row.mailbox_id,
    uid: row.uid,
    uidValidity: row.uid_validity,
    internalDate: row.internal_date,
    flags: parseJson(row.flags_json, []),
    envelope: parseJson(row.envelope_json, null)
  };
}

/**
 * @param {unknown} value
 * @returns {boolean|null}
 */
function optionalBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new MessageSearchError('invalid_filter');
  return value;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new MessageSearchError('invalid_filter');
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function normalizeChoice(value, allowed, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) throw new MessageSearchError('invalid_sort');
  return value;
}

/**
 * @param {unknown} limit
 * @param {boolean} legacy Clamp out-of-range positional limits.
 * @returns {number}
 */
function normalizeLimit(limit, legacy) {
  if (limit === undefined) return LIMIT_DEFAULT;
  if (legacy) return Math.min(Math.max(Number(limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new MessageSearchError('invalid_limit');
  return limit;
}

/**
 * @param {unknown} cursor
 * @returns {string|null}
 */
function normalizeCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length === 0) throw new MessageSearchError('invalid_cursor');
  return cursor;
}

/**
 * @param {unknown} mailboxId
 * @param {unknown} mailboxIds
 * @returns {string[]}
 */
function normalizeMailboxes(mailboxId, mailboxIds) {
  const values = [];
  if (mailboxId !== undefined && mailboxId !== null) {
    if (typeof mailboxId !== 'string' || mailboxId.length === 0) throw new MessageSearchError('invalid_mailbox');
    values.push(mailboxId);
  }
  if (mailboxIds !== undefined && mailboxIds !== null) {
    if (!Array.isArray(mailboxIds)) throw new MessageSearchError('invalid_mailbox');
    for (const id of mailboxIds) {
      if (typeof id !== 'string' || id.length === 0) throw new MessageSearchError('invalid_mailbox');
      values.push(id);
    }
  }
  return [...new Set(values)].sort();
}

/**
 * @param {unknown} flags
 * @param {unknown} includeFlags
 * @returns {string[]}
 */
function normalizeFlags(flags, includeFlags) {
  const values = [];
  for (const source of [flags, includeFlags]) {
    if (source === undefined || source === null) continue;
    if (!Array.isArray(source)) throw new MessageSearchError('invalid_flags');
    for (const flag of source) {
      if (typeof flag !== 'string' || flag.trim() === '') throw new MessageSearchError('invalid_flags');
      values.push(flag);
    }
  }
  const seen = new Set();
  const unique = [];
  for (const flag of values) {
    const key = flag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(flag);
  }
  return unique;
}

/**
 * Resolve one UTC instant from a primary field and its alias.
 * @param {unknown} primary
 * @param {unknown} alias
 * @returns {string|null}
 */
function oneInstant(primary, alias) {
  const first = readInstant(primary);
  const second = readInstant(alias);
  if (first && second && first !== second) throw new MessageSearchError('invalid_date');
  return first ?? second;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function readInstant(value) {
  if (value === undefined || value === null) return null;
  return parseUtcInstant(value);
}

/**
 * Validate an ISO-8601 date or date-time and return its UTC instant.
 * Date-only values start at 00:00:00.000Z.
 * @param {unknown} value
 * @returns {string}
 */
function parseUtcInstant(value) {
  if (typeof value !== 'string') throw new MessageSearchError('invalid_date');
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
      throw new MessageSearchError('invalid_date');
    }
    return utc.toISOString();
  }
  const match = DATE_TIME.exec(value);
  if (!match) throw new MessageSearchError('invalid_date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) throw new MessageSearchError('invalid_date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MessageSearchError('invalid_date');
  const offset = match[8];
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const [offsetHours, offsetMins] = offset.slice(1).split(':').map(Number);
    if (offsetHours > 23 || offsetMins > 59) throw new MessageSearchError('invalid_date');
    offsetMinutes = sign * ((offsetHours * 60) + offsetMins);
  }
  const wall = new Date(parsed.getTime() + (offsetMinutes * 60 * 1000));
  if (
    wall.getUTCFullYear() !== year
    || wall.getUTCMonth() !== month - 1
    || wall.getUTCDate() !== day
    || wall.getUTCHours() !== hour
    || wall.getUTCMinutes() !== minute
    || wall.getUTCSeconds() !== second
  ) {
    throw new MessageSearchError('invalid_date');
  }
  return parsed.toISOString();
}

/**
 * @param {string} value
 * @returns {string}
 */
function containsLike(value) {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * @param {string[]} where
 * @param {unknown[]} params
 * @param {string} predicate SQL boolean expression with LIKE placeholders.
 * @param {string} needle User text.
 * @param {number} copies How many times the pattern is bound.
 */
function addLike(where, params, predicate, needle, copies) {
  where.push(`(${predicate})`);
  const pattern = containsLike(needle);
  for (let index = 0; index < copies; index += 1) params.push(pattern);
}

/**
 * @returns {string}
 */
function subjectPredicate() {
  return `CASE WHEN json_valid(envelope_json) THEN lower(COALESCE(json_extract(envelope_json, '$.subject'), '')) ELSE '' END LIKE ? ESCAPE '\\'`;
}

/**
 * @param {string[]} where
 * @param {unknown[]} params
 * @param {'from'|'to'|'cc'} field Envelope party field.
 * @param {string} needle
 */
function addParty(where, params, field, needle) {
  if (!PARTY_FIELDS.has(field)) throw new MessageSearchError('invalid_filter');
  where.push(`(
    CASE WHEN json_valid(envelope_json) THEN lower(COALESCE(json_extract(envelope_json, '$.${field}'), '')) ELSE '' END LIKE ? ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM json_each(
        CASE
          WHEN json_valid(envelope_json) AND json_type(envelope_json, '$.${field}') = 'array'
            THEN json_extract(envelope_json, '$.${field}')
          ELSE '[]'
        END
      ) AS party
      WHERE lower(COALESCE(json_extract(party.value, '$.address'), '')) LIKE ? ESCAPE '\\'
         OR lower(COALESCE(json_extract(party.value, '$.name'), '')) LIKE ? ESCAPE '\\'
         OR lower(CAST(party.value AS TEXT)) LIKE ? ESCAPE '\\'
    )
  )`);
  const pattern = containsLike(needle);
  params.push(pattern, pattern, pattern, pattern);
}

/**
 * @returns {string}
 */
function seenPredicate() {
  return `EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(flags_json) THEN flags_json ELSE '[]' END) AS flag
    WHERE lower(flag.value) = '\\seen'
  )`;
}

/**
 * @returns {string}
 */
function attachmentPredicate() {
  return `(CASE
    WHEN json_valid(attachments_json) THEN
      CASE
        WHEN json_type(attachments_json) = 'array' THEN CASE WHEN json_array_length(attachments_json) > 0 THEN 1 ELSE 0 END
        ELSE 0
      END
    ELSE 0
  END = 1
  OR lower(COALESCE(raw_mime, '')) LIKE '%content-disposition:%attachment%' ESCAPE '\\')`;
}

/**
 * @param {object} normalized
 * @returns {string}
 */
function filterFingerprint(normalized) {
  const canonical = {
    accountId: normalized.accountId,
    query: normalized.query,
    subject: normalized.subject,
    from: normalized.from,
    to: normalized.to,
    cc: normalized.cc,
    mailboxIds: normalized.mailboxIds,
    since: normalized.since,
    before: normalized.before,
    isRead: normalized.isRead,
    isUnread: normalized.isUnread,
    hasAttachment: normalized.hasAttachment,
    flags: normalized.flags,
    sortBy: normalized.sortBy,
    sortOrder: normalized.sortOrder
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

/**
 * @param {object} row Last row returned on this page.
 * @param {object} normalized
 * @returns {string}
 */
function encodeCursor(row, normalized) {
  const payload = {
    v: 1,
    h: filterFingerprint(normalized),
    sortBy: normalized.sortBy,
    sortOrder: normalized.sortOrder,
    sortValue: normalized.sortBy === 'uid' ? row.uid : row.sort_date,
    id: row.message_key
  };
  return `ms1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/**
 * @param {string} token Opaque cursor.
 * @param {object} normalized Current criteria.
 * @returns {{ sortValue: string|number, id: string }}
 */
function decodeCursor(token, normalized) {
  if (!token.startsWith('ms1.')) throw new MessageSearchError('invalid_cursor');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw new MessageSearchError('invalid_cursor');
  }
  if (!payload || payload.v !== 1 || payload.h !== filterFingerprint(normalized)) throw new MessageSearchError('invalid_cursor');
  if (payload.sortBy !== normalized.sortBy || payload.sortOrder !== normalized.sortOrder) throw new MessageSearchError('invalid_cursor');
  if (typeof payload.id !== 'string' || payload.id.length === 0) throw new MessageSearchError('invalid_cursor');
  if (normalized.sortBy === 'uid') {
    if (!Number.isInteger(payload.sortValue)) throw new MessageSearchError('invalid_cursor');
  } else if (typeof payload.sortValue !== 'string') {
    throw new MessageSearchError('invalid_cursor');
  }
  return payload;
}

/**
 * @param {object} normalized
 * @returns {object}
 */
function appliedFilters(normalized) {
  return {
    query: normalized.query,
    subject: normalized.subject,
    from: normalized.from,
    to: normalized.to,
    cc: normalized.cc,
    mailboxIds: [...normalized.mailboxIds],
    since: normalized.since,
    before: normalized.before,
    isRead: normalized.isRead,
    isUnread: normalized.isUnread,
    hasAttachment: normalized.hasAttachment,
    flags: [...normalized.flags],
    limit: normalized.limit,
    sortBy: normalized.sortBy,
    sortOrder: normalized.sortOrder
  };
}
