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

## Receiver, sync and send (T-102 b to d, 2026-11-01)

The adapter above is wired into the services like this. Nothing here reaches Google unless the `gmail`
integration is complete in the credential store (ADR-004 / ADR-012); until then every process runs on the
in-memory `FakeGmailTransport`.

| Piece | Where | What it does |
|---|---|---|
| Push receiver | `apps/api/src/gmail/` | `POST /v1/inbound/gmail/push`: per-IP rate limit, verify the Pub/Sub OIDC token (`jose`, RS256, `iss`/`aud`/`email`/`email_verified`/`exp`), set `gmail_account_state.last_push_at`, write ONE outbox job on the `gmail` queue (`jobId = push-<account>-<Pub/Sub messageId>`). Authentic but unreadable or unknown-mailbox messages are acknowledged and dropped (no poison loop). Not configured: 503. |
| History sync | `apps/worker/src/gmail/sync.ts` | cursor in `gmail_account_state.history_id`; `history.list` (messageAdded) per page; one `inbound_event` (+ `ingest` job) per Gmail message id; 404 or no cursor = bounded full sync (`GMAIL_FULL_SYNC_DAYS`, `GMAIL_FULL_SYNC_MAX_MESSAGES`), audited. The existing ingest consumer fetches, normalises, and stores raw mail and attachments in object storage. |
| Watch renewal | `watch.ts` + schedule | `users.watch` for every mailbox once a day (02:15 UTC) and at boot; failure = unhealthy + audit + retry. |
| Heartbeat (R-2.8) | `heartbeat.ts` + schedule | every 10 min: business minutes since the last push against `GMAIL_HEARTBEAT_STALE_MINUTES`, or a lapsed watch: unhealthy + one audit entry + catch-up sync. |
| Runtime | `runtime.ts` | one object for sync, ingest fetch and the outbound `GmailSender` (From = the mailbox in `gmail_account_state`). Live only with a complete credential and only for the mailbox it delegates to. |

Checked against official documentation on 2026-11-01:

| Fact | Status | Source |
|---|---|---|
| Push request carries `Authorization: Bearer <JWT>` (RS256, `kid`); claims `iss` = `https://accounts.google.com` (also `accounts.google.com` in the Go sample), `aud` = the subscription's audience, `email` = the push service account, `email_verified` = true, `exp` = `iat` + 3600; a token may be up to an hour old | `[CONFIRMED]` | https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions |
| Wrapped push body: `message.data` (base64), `messageId`, `publishTime`, `attributes`, `subscription`; 102/200/201/202/204 acknowledge, anything else is a nack and is redelivered | `[CONFIRMED]` | https://docs.cloud.google.com/pubsub/docs/push |
| Signing keys: `jwks_uri` of Google's OpenID discovery document is `https://www.googleapis.com/oauth2/v3/certs` (the Pub/Sub page itself does not name the URL) | `[CONFIRMED]` for Google ID tokens, `[VERIFY]` that push tokens use the same key set before the first live run | https://accounts.google.com/.well-known/openid-configuration |
| Service account with domain-wide delegation: RS256 JWT assertion (`iss`, `sub`, `scope`, `aud` = `https://oauth2.googleapis.com/token`, `iat`, `exp` at most 1 h), POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` + `assertion` | `[CONFIRMED]` | https://developers.google.com/identity/protocols/oauth2/service-account |
| Scopes requested: `gmail.readonly` + `gmail.send` (not `gmail.modify`). Each method the live transport calls accepts one of them: `users.history.list`, `users.messages.get`, `users.watch` and `users.stop` accept `gmail.readonly`; `users.messages.send` accepts `gmail.send` | `[CONFIRMED]` per method | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch , `.../users/stop` , `.../users.messages/send` , `.../users.messages/get` , `.../users.history/list` (read 2026-11-01) |
| `messages.get` with `format=raw` under `gmail.readonly` (the page does not tie `raw` to a scope) | `[VERIFY]` on the first live run | same |
| Whether Gmail keeps the `Message-ID` we set on `messages.send` (the dispatcher stores it as the dedupe key for the answer) | `[VERIFY]` (ADR-010 section 6) | |

## OAuth of the support mailbox (T-102e, 2026-11-01)

The default way to reach the mailbox (owner decision; service account with domain-wide delegation stays an option).
A `head` runs Google's web server flow once; the worker then keeps using the refresh token.

| Piece | Where | What it does |
|---|---|---|
| Helpers | `oauth.ts` (this package) | authorization URL, PKCE (S256), code exchange, refresh, `users.getProfile`, revoke, and `createOAuthTokenProvider` (a `TokenProvider`, same contract as the service-account one). Injected `fetch`, no Google client library. |
| Routes | `apps/api/src/gmail/gmail-oauth.*` | `POST /v1/admin/integrations/gmail/oauth/start` (JSON `{ mailbox }` returns `{ authorizationUrl, expiresAt, redirectUri }`), `GET .../gmail/oauth/callback` (Google redirects here; answers 302 to `<APP_URL>/admin/integrations?gmail_oauth=<result>`), `GET .../gmail/oauth/status`. All `integration.manage` (head). |
| Storage | credential store, integration `gmail` | `oauthClientId`, `oauthClientSecret` (typed on the admin page or env), `oauthRefreshToken`, `oauthMailbox` (written by the callback). Encrypted, write-only, audited by field name. |
| Worker | `apps/worker/src/gmail/runtime.ts`, `not-connected.ts` | picks the OAuth or the service-account provider from what is configured; `invalid_grant` marks the mailbox not connected. |

**Redirect URI** to register on the OAuth client (type "Web application"): `<API_URL>/v1/admin/integrations/gmail/oauth/callback`.
**Scopes**: exactly `gmail.readonly` and `gmail.send`; the callback refuses any other grant (fewer, more or different) and revokes it.

What the callback checks, in order: the `state` exists (Redis, hashed key, ten minutes, deleted on first use, so a replay is refused);
it was started by this person in this SESSION (the PKCE verifier stays on the server); Google did not return an error; the granted
scopes are exactly the two; a refresh token was issued; the address that granted (`users.getProfile`) is the mailbox asked for at
`start`. Only then is the refresh token written (one transaction with the audit entry, the mailbox row, and a catch-up sync job).
Anything refused after Google issued a token revokes THAT token (best effort, the outcome `revoked` / `failed` is in the audit entry),
except when a working grant is stored and the refused one may belong to the same account (same mailbox, or the account is not known
yet): then nothing is revoked (`skipped_working_grant`), because whether revoking one refresh token ends the whole grant of an account
is `[UNVERIFIED 50%]`. A reconnection that changes the mailbox revokes the old mailbox's token after the new one is saved (audit
`gmail.oauth.disconnect`, reason `mailbox_changed`); the same mailbox reconnecting leaves the old token alone. `POST .../gmail/oauth/disconnect`
revokes and deletes the grant; the generic `PUT` / `DELETE` of `oauthRefreshToken` and `oauthMailbox` are refused (400) so that no token
can be stored without the scope and `getProfile` checks. The worker reads the credential at every use (no 60 s window), names the
mailbox in the URL (`users/<address>` instead of `me`), and `not_connected` is not overwritten by later sync or watch errors. Result codes: `connected`, `denied`, `state_invalid`,
`scope_mismatch`, `mailbox_mismatch`, `no_refresh_token`, `env_locked`, `unavailable`.

**Which way is used** when both are complete (`chooseGmailMethod`, `packages/shared/src/features/gmail.ts`):
1. a way whose fields are ALL set by the ENVIRONMENT beats one that is not (ADR-004/012: environment wins; a click on the
   admin page must not override the operator's deployment). One stray variable next to a database value does not count, and
   `start` / the callback answer 409 / `env_locked` when connecting could not become the effective way;
2. otherwise OAuth. A warning (no value) is logged once when both exist.
If neither is complete the mailbox is not connected (no mock unless `GMAIL_MOCK_ENABLED`, and never after a live credential was seen).

**`invalid_grant`** (revoked, expired, password changed while the token holds Gmail scopes, 100-token cap, or a consent screen in
"Testing", which lasts 7 days) is a `ChannelError` of operation `oauth2.token`, kind `auth`, code `invalid_grant`, not retryable by
itself. The dispatcher already treats that operation as a certain non-delivery (the token comes before any send), so the delivery fails
visibly as `channel_auth` and an agent can retry it after reconnecting. The token provider calls `onNotConnected`: the channel account
goes `unhealthy`, `gmail_account_state.last_error_code = 'not_connected'` (the sync job and the watch renewal keep that code instead of
overwriting it), and ONE `gmail.not_connected` audit entry per outage. The sync job fails, so BullMQ retries it. Connecting again
clears the code, queues a sync, and the heartbeat marks the mailbox healthy.

Checked against official documentation on 2026-11-01 (details in `oauth.ts`):

| Fact | Status | Source |
|---|---|---|
| Authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`; `response_type=code`, `scope`, `state`, `access_type=offline`, `prompt=consent`, `login_hint`; the user may grant fewer scopes than requested, so the returned `scope` must be checked | `[CONFIRMED]` | https://developers.google.com/identity/protocols/oauth2/web-server |
| Token endpoint `https://oauth2.googleapis.com/token`; exchange (`code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`) and refresh (`grant_type=refresh_token`); response `access_token`, `expires_in`, `refresh_token`, `scope`, `token_type` | `[CONFIRMED]` | same page, and https://developers.google.com/identity/protocols/oauth2/native-app |
| PKCE `code_challenge` + `code_challenge_method=S256` + `code_verifier` (verifier 43 to 128 chars) | `[CONFIRMED]` on the native-app page; accepted for a Web application client with a secret `[VERIFY]` on the first live run (RFC 7636) | native-app page |
| A refresh token stops working when revoked, unused 6 months, password changed (Gmail scopes), over 100 per account per client, 7 days for an External consent screen in "Testing", admin session policy; refresh then answers `invalid_grant` | `[CONFIRMED]` | https://developers.google.com/identity/protocols/oauth2#expiration |
| `users.getProfile`: `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/profile`, authorised by `gmail.readonly` (among others), returns `emailAddress` | `[CONFIRMED]` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile |
| Revoke `POST https://oauth2.googleapis.com/revoke` with `token` | `[VERIFY]` | Google "Revoking a token" |
| Hosts reached: `accounts.google.com` (browser redirect only), `oauth2.googleapis.com`, `gmail.googleapis.com`. PRD §11 lists the Gmail API and "Google Workspace SSO" but names no host; this task adds the three hosts there. | `[CONFIRMED]` | PRD §11 |

Never exercised against Google by this repository `[ASK-HUMAN]` before the first live run (needs the owner's OAuth client).

### Domain-wide delegation: blast radius (read before granting it)

Domain-wide delegation lets the service account act as ANY user of the Workspace domain for the scopes
the admin grants it in the Admin console, not only as the support mailbox. The code asks for the
two narrowest scopes it needs and impersonates one user (`impersonateUser`), but the grant itself is
what limits the damage if the key leaks. So: grant exactly `gmail.readonly` and `gmail.send` (never
`gmail.modify`, `gmail.compose` or `https://mail.google.com/`), keep the key file outside the repo
(environment or the encrypted credential store, N1), rotate it (`credentials rotate`) when anyone who
could read it leaves, and prefer a dedicated support mailbox over a personal one. An OAuth refresh token
of a dedicated support user is the narrower alternative (R-2.4).

### Mock mode is an explicit opt-in

`createGmailRuntime` hands out the in-memory fake only with `allowMock`, which the worker sets from
`GMAIL_MOCK_ENABLED=true` (default false, also in compose and `.env.example`). `NODE_ENV` is not used:
compose defaults it to `development` on a real deployment. The config guard refuses the flag in
production and on any `APP_URL` that is not loopback (the same pattern as `DEV_LOGIN_ENABLED`). Without
the flag, with no complete `gmail` credential the runtime returns no transport and no sender: sync
records `transport_unavailable` and a customer reply fails visibly as `channel_not_connected`. Once a
complete credential has been seen the runtime never goes back to the fake, even with the flag: a revoked
or half-edited credential reads as "not connected". If the credential store cannot be read, transport /
sender calls throw a retryable error: the ingest event is retried, and the dispatcher backs off and,
after `DELIVERY_MAX_ATTEMPTS`, fails the delivery as `channel_credentials_unavailable` (certain
non-delivery, visible to the agent). The tests and the e2e stack (`tools/e2e-stack/up.mjs`) set the flag.
