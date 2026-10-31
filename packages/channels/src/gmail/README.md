# Gmail adapter (T-102a)

Pure adapter layer for Gmail: transport interface with an in-memory fake and a live stub, MIME
normaliser, HTML sanitiser, auto-reply / bounce / noise detection, thread keys and the in-thread reply
builder. No database, no queue, no Pub/Sub receiver, no sync loop (T-102b to T-102e).

| File | What it is |
|---|---|
| `transport.ts` | `GmailTransport` interface (`listHistory`, `listMessages`, `getMessage`, `sendMessage`, `watch`, `stopWatch`), Zod schemas, `isHistoryExpired`, `decodeGmailPushData` |
| `fake.ts` | `FakeGmailTransport`: mailbox in memory, history ids, 404 on expired history, threading, `failNext` |
| `live.ts` | `LiveGmailTransport`: injected `fetch` and `getAccessToken`, no google-auth-library, no ADC probing |
| `mime.ts` | byte-safe MIME parser: headers, RFC 2047 words, RFC 2231 parameters, addresses, multipart tree, charsets |
| `html.ts` | allow-list rebuild sanitiser, plain-text rendering, `cid:` image tracking |
| `normalize.ts` | `normalizeMime` to `NormalizedEmail` + attachment bytes |
| `classify.ts` | `classifyAutomated`: `human` / `auto_reply` / `noise` with a subtype and the evidence |
| `threads.ts` | `buildThreadKeys` (R-2.3 candidate order), `extractTicketKeys` |
| `reply.ts` | `buildReply`, `makeMessageId` (headers for an in-thread send) |
| `adapter.ts` | `GmailAdapter` (`ingest`, `send`, `markRead` = unsupported, `capabilities`) |

Fixtures in `__fixtures__/*.eml` are synthetic (`example.com` only); the Thai ones are generated, so
they contain real TIS-620 / windows-874 bytes inside quoted-printable and base64. Tests read them with
CRLF line endings, like SMTP. `transport.contract.ts` runs against the fake always and against the
live transport only with `CONTRACT_LIVE=1` (`[ASK-HUMAN]`; `CONTRACT_LIVE_WRITE=1` allows send and
watch). Nothing in this repo sets either.

## Checked against official documentation (2026-10-31, Asia/Bangkok)

| Fact | Status | Source |
|---|---|---|
| `watch` must be called at least every 7 days, once a day is recommended; the response carries `historyId` and `expiration` (epoch ms) | `[CONFIRMED]` | https://developers.google.com/workspace/gmail/api/guides/push and `.../reference/rest/v1/users/watch` |
| Push payload: Pub/Sub `message.data` is **base64url** JSON `{"emailAddress", "historyId"}`; Gmail needs publish rights for `gmail-api-push@system.gserviceaccount.com` on the topic | `[CONFIRMED]` | push guide |
| `history.list`: `startHistoryId` required, `maxResults` default 100 and max 500, `historyTypes`, `labelId`; an invalid or too old id typically returns **404** and the client must do a full sync; a history id is "typically valid for at least a week" but sometimes only a few hours | `[CONFIRMED]` | https://developers.google.com/workspace/gmail/api/guides/sync and `.../users.history/list` |
| `watch` accepts `labelIds` and a label filter; `labelFilterAction` is deprecated in favour of `labelFilterBehavior` (we send `INCLUDE` / `EXCLUDE`) | `[CONFIRMED]` field; enum spelling `[VERIFY]` | `.../users/watch` |
| Threading a sent message: supply `threadId`; `References` and `In-Reply-To` must follow RFC 2822; **the Subject must match** | `[CONFIRMED]` | https://developers.google.com/workspace/gmail/api/guides/threads |
| Endpoints: `GET /gmail/v1/users/{userId}/history`, `.../messages`, `.../messages/{id}`, `POST .../messages/send`, `POST .../watch`, `POST .../stop` | `[CONFIRMED]` | reference pages above |
| RFC 3834: `Auto-Submitted` is `no` or `auto-generated` / `auto-replied` / an extension token; any value other than `no` marks an automatic message; `auto-replied` is the right label for our own auto-acks; DSNs and MDNs must not use `auto-generated` (but some MTAs do) | `[CONFIRMED]` | https://www.rfc-editor.org/rfc/rfc3834.txt |
| Whether Gmail keeps a caller-supplied `Message-ID` on `messages.send` | `[VERIFY]` (ADR-010 section 6) | |
| Whether a `Re:` prefix on the subject still threads | `[VERIFY]`; `buildReply` keeps the parent subject exactly by default (R-2.3) and `subjectMode: 'prefix_re'` is opt-in | |
| Service account with domain-wide delegation and `gmail.modify`, send-as aliases | `[ASSUMED]` (PRD R-2.4); nothing here depends on how the token is made | |

## Design notes

- **Sanitiser is a rebuild, not a filter.** Output is assembled only from allow-listed elements and
  attributes with all text escaped. Scripts, styles, frames, forms, SVG, `style`, `class`, event
  handlers and remote images are dropped (remote images are tracking pixels; they are counted in
  `remoteImagesBlocked`). Links keep `http(s):`, `mailto:`, `tel:` only, with `rel="noopener noreferrer
  nofollow" target="_blank"`. `<img>` survives only as `cid:` and then points at an attachment
  part of the same message (`referencedByHtml`). The UI should still render it inside a sandboxed
  container with a CSP; the sanitiser is the first of two layers.
- **Charsets.** TIS-620, ISO-8859-11 and windows-874 all decode as windows-874. A latin1 / us-ascii label
  on bytes that are valid multi-byte UTF-8 is read as UTF-8 (mislabelled mail). An unknown or missing
  label tries UTF-8, then windows-874. Thai mislabelled as ISO-8859-1 with TIS-620 bytes is **not**
  guessed (it would break real Latin-1 mail); such a message shows mojibake and stays `[VERIFY]` against
  real mail.
- **Classification rules** (`classify.ts`), first match wins: DSN structure, `X-Failed-Recipients`,
  MAILER-DAEMON / postmaster or null `Return-Path` give `auto_reply/bounce`; `X-Autoreply`-style
  headers, `Precedence: auto_reply`, `Auto-Submitted` other than `no` give `auto_reply`;
  `List-Id` / `List-Unsubscribe` / `List-Post` / `Feedback-ID` give `noise/mailing_list`;
  `Precedence: bulk|junk|list` alone gives `auto_reply/precedence_bulk` (R-2.6);
  Gmail `SPAM` / `CATEGORY_*` labels and `no-reply` senders give `noise`. A subject like "Automatic
  reply:" alone only sets `suspect: true`; the mail stays `human`, so a real customer is never dropped
  by a subject line. Every non-`human` verdict has `suppressAutoAck: true`.
- **Thread keys** (`threads.ts`): candidates in the order Gmail `threadId`, `In-Reply-To`,
  `References` newest first, `[PREFIX-n]` in the subject. The adapter only lists them; the lookup and the
  append-or-create decision are `domain.ingestInbound` (ADR-009). Message-IDs are compared lower-cased.
- **No automatic retry of a send after an unknown outcome** (no Gmail idempotency key, ADR-010): only a 429
  is retried. Reads retry on 429 / 5xx / timeout with full-jitter backoff and `Retry-After`.
- **No secrets in output.** Errors carry status, operation and Google's reason code, never the token,
  a body or Google's free-text message.
