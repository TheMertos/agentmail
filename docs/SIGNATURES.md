# Signatures and HTML mail

Signatures are first-class, account-scoped resources. A message may use one selected signature, not an automatically duplicated global footer.

## Supported signature profiles

Each profile contains:

- stable ID and display name;
- account binding (`info@mertyagci.de`, Gmail, or another connected account);
- optional identity/display name and reply address;
- HTML body;
- generated or explicitly supplied plain-text fallback;
- optional inline images referenced by Content-ID;
- optional provider/recipient/language rules;
- enabled/disabled status and version history.

Examples:

```text
Info — Professional HTML
Info — Short reply
Gmail — Plain professional
Job application — HTML CV links
No signature
```

The existing `/home/mert/mail/signatur.html` can be imported into an `info@mertyagci.de` profile, but it must not be copied or silently used for Gmail.

## Selection rules

Selection precedence:

1. explicit choice in the send preview;
2. account + sender identity default;
3. matching provider/recipient/language rule;
4. no signature.

The selected profile and its version are displayed before approval. Changing the signature after approval invalidates the send approval.

## MIME output

Every HTML-capable message has both alternatives:

- `text/plain`: generated body plus plain-text signature fallback;
- `text/html`: generated body plus sanitized signature HTML.

HTML signatures are inserted exactly once between the new message and the quoted original. The quote remains at the bottom and is never included inside the signature resource.

Inline images use CID attachments where possible. Remote images are disabled by default or clearly marked as external content. HTML must not contain scripts, forms, event handlers, tracking pixels, active CSS, or unsafe URLs. Sanitize on import and again at render time.

## Approval preview

The final preview shows:

- From, To, Cc, Bcc and subject;
- rendered HTML preview;
- plain-text alternative;
- selected signature name and version;
- attachments and inline images;
- complete quoted original;
- warnings for remote content, missing plain-text fallback, or changed signature version.

The approval binds to a hash of all of the above. Any edit to body, recipients, account, attachments, quote, or signature invalidates it.

## Account policy examples

- `info@mertyagci.de`: may offer the imported personal HTML signature and the AI footer as separate composable components.
- Gmail: must not offer the `info@mertyagci.de` personal signature unless a separate Gmail profile is explicitly created.
- AI footer: should be a separately managed system component, visible in the preview and included exactly once when the account policy requires it.

## Data model

```text
SignatureProfile
  id
  account_id
  name
  html_body_sanitized
  text_body
  inline_assets
  rules
  enabled

SignatureVersion
  profile_id
  version
  html_body_sanitized
  text_body
  content_hash
  created_at

AccountSignaturePolicy
  account_id
  default_profile_id
  require_html
  require_plain_text
  require_ai_footer
  allow_remote_images
```

Signature HTML is not a secret. It is still untrusted markup and must be isolated from the application UI and sanitized before storage/rendering.

## Acceptance tests

- Import `/home/mert/mail/signatur.html` into an `info` profile without leaking its contents to logs.
- Gmail cannot accidentally select the `info` profile.
- A selected signature appears exactly once in both HTML and plain-text alternatives.
- Switching profiles changes the content hash and invalidates an earlier approval.
- Unsafe tags, event handlers, JavaScript URLs, and remote tracking pixels are rejected or neutralized.
- Inline image attachments have matching Content-ID references.
- A message without a signature remains valid and has a correct plain-text alternative.
- Read-back of a sent message verifies From, MIME parts, signature version/hash, and one occurrence of each component.
