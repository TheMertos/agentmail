# Reply target resolution

AgentMail never guesses which message a reply, forward, or quote refers to. Every compose-as-reply operation requires an explicit, previously resolved message reference.

## Required input

A reply/forward operation must receive:

```text
sourceMessageKey   # exact local key: accountId:mailboxId:uidValidity:uid
```

This key comes only from a prior `message_search` or `message_list`/`thread_read` result already shown to the user or explicitly selected by Hermes after search. It is never inferred from "the newest message," a sender name alone, or a subject guess.

## Resolution steps

1. Look up the exact stored message by `sourceMessageKey`.
2. If it does not exist locally, fail closed with `source_message_not_found`; do not fall back to a fuzzy match.
3. Read `Message-ID`, `In-Reply-To`, `References`, `From`, `To`, `Cc`, `Subject`, `Date` from the source envelope/raw MIME — never from a caller-supplied guess of those fields.
4. Build the new message headers:
   - `In-Reply-To`: source `Message-ID`
   - `References`: source `References` (if any) + source `Message-ID`
   - `Subject`: `Re: <original subject>` unless already prefixed
   - default `To`: source `From` (reply) or source `To`+`Cc` minus self (reply-all)
5. Extract the source body (`text/html` preferred, `text/plain` fallback) as the quoted content passed to `composeReplyParts`.
6. Compute quote depth from the number of existing `blockquote.gmail_quote` levels in the source HTML, or from counting leading `>` groups in the source plain text.

## Ambiguity handling

If a user request names a sender/topic instead of a concrete message ("Tessa'nın son mailine cevap ver"), the flow is:

```text
message_search(criteria) -> candidate list (id, subject, from, date, snippet)
  -> exactly one candidate: use its key automatically only if unambiguous
  -> more than one candidate: surface the list and require an explicit pick
  -> zero candidates: report not found, do not draft
```

A "most recent" search result is only used automatically when the request explicitly says "the latest" or "most recent" AND the candidate set is unambiguous by date; otherwise resolution stops and asks which message.

## MCP contract

```text
draft_create({ accountId, replyTo: { sourceMessageKey, mode: "reply"|"reply-all"|"forward" }, ...})
```

`replyTo.sourceMessageKey` is mandatory for any reply/forward draft. A draft without it is treated as a new, unrelated message and must not silently attach a quote.

## Failure modes

- missing key: `source_message_not_found`
- key belongs to a different account than the requested send account: `account_mismatch`
- source message body unavailable locally: trigger a scoped re-fetch before drafting, or fail with `source_body_unavailable`
- more than one thread candidate and no explicit selection: `ambiguous_source_message`
