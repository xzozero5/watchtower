# LINE adapter (T-103a)

Pure adapter layer for LINE Official Account messaging: webhook signature check, event
normaliser, transport interface with an in-memory fake and a live stub, the reply-vs-push router and
quota accounting. No database, no queue, no HTTP server (those are T-103b and later).

| File | What it is |
|---|---|
| `signature.ts` | `computeLineSignature`, `verifyLineSignature` (HMAC-SHA256 base64 over the raw body, constant-time compare) |
| `events.ts` | `parseLineWebhook(rawBody)` to `NormalizedLineEvent[]` (one per event, `providerEventId = webhookEventId`) |
| `transport.ts` | `LineTransport` interface: `reply`, `push` (retry key), `getQuota`, `getConsumption`, `getContent`, `markAsRead`, `showLoadingAnimation` |
| `fake.ts` | `FakeLineTransport`: single-use + expiring reply tokens, retry-key idempotency, quota, `failNext` |
| `live.ts` | `LiveLineTransport`: injected `fetch` and token provider, timeout, retry, `Retry-After`, no ADC |
| `router.ts` | `decideLineRoute`: pure reply-vs-push decision with a reason |
| `quota.ts` | quota evaluation, reserve / release, reconcile, billing period |
| `adapter.ts` | `LineAdapter` (`ingest`, `send`, `markRead`, `capabilities`) |

Tests: `*.test.ts` next to the code. `transport.contract.ts` is one suite run against the fake always
and against the live transport only with `CONTRACT_LIVE=1` (`[ASK-HUMAN]`; add `CONTRACT_LIVE_WRITE=1`
to allow pushes). Nothing in this repo sets either variable. The webhook-signature tests generate
a random channel secret at run time.

## What was checked against LINE's official documentation

Checked 2026-10-31 (Asia/Bangkok) by reading the pages below. `[CONFIRMED]` = stated on the page,
`[VERIFY]` = not stated, or stated with a caveat that needs a real account to settle.

| Fact | Status | Source |
|---|---|---|
| Signature header is `x-line-signature`; algorithm HMAC-SHA256; key is the channel secret; input is the exact request body (UTF-8, do not parse or reformat first); the example pipes the digest through `openssl base64` | `[CONFIRMED]` | https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/ |
| The page does not say to compare in constant time | note | same page. We use `timingSafeEqual` regardless. |
| Redelivery is **off by default** and turned on in the console (Messaging API tab, "Webhook redelivery"); a redelivered event keeps the same `webhookEventId` and differs only in `deliveryContext.isRedelivery`; redelivery happens when the bot server does not return 2xx; number and interval of retries are not disclosed | `[CONFIRMED]` | https://developers.line.biz/en/docs/messaging-api/receiving-messages/ |
| LINE recommends processing webhooks asynchronously; no response-time limit is given | `[CONFIRMED]`, response deadline `[VERIFY]` | same page |
| `webhookEventId` is a string in ULID format; `timestamp` is the event time in ms even for a redelivery; `mode` is `active` or `standby` and a `standby` event carries no reply token and the bot must not send anything | `[CONFIRMED]` | https://developers.line.biz/en/reference/messaging-api/#common-properties (read through the no-JS copy `/nojs/`) |
| Message event fields we read: `message.id`, `quoteToken`, `markAsReadToken` (no expiry), text `text`, image/video/audio `contentProvider.type` (`line` or `external`), image `imageSet`, file `fileName` / `fileSize`, location `title` / `address` / `latitude` / `longitude`, sticker `packageId` / `stickerId` / `stickerResourceType` / `keywords`; follow event `follow.isUnblocked` | `[CONFIRMED]` | reference, "Message event", "Follow event" |
| **Reply token**: "can only be used once", "must be used within one minute after receiving the webhook", "use beyond one minute isn't guaranteed to work", the limit "is subject to change without notice" and "don't rely on the time limit"; a token in a redelivered webhook can also be used for one minute after the redelivery arrives, but not if it was already used or **20 minutes** have passed since the event | `[CONFIRMED]` | https://developers.line.biz/en/reference/messaging-api/#send-reply-message |
| Our default token lifetime: 50 s with a 3 s margin (`router.ts`, configurable, validated to at most 60 s). 50 s comes from ADR-010 `[ASSUMED]`; the exact server-side lifetime is not published | `[VERIFY]` with a real account before relying on the margin | |
| **`X-Line-Retry-Key`**: a hexadecimal UUID the caller generates; valid 24 h from the first request; accepted by push, multicast, narrowcast and broadcast only (other APIs answer **400**, so **reply does not support it**); a repeated key gets **409** with the first request's id in `x-line-accepted-request-id`; retry on 5xx and network timeouts; do not retry other 4xx; retries count toward the rate limit; the key does not guarantee delivery (blocked user) | `[CONFIRMED]` | https://developers.line.biz/en/docs/messaging-api/retrying-api-request/ and the push endpoint in the reference |
| Endpoints used: `POST /v2/bot/message/reply`, `POST /v2/bot/message/push`, `GET /v2/bot/message/quota`, `GET /v2/bot/message/quota/consumption`, `POST /v2/bot/chat/markAsRead` (body `markAsReadToken`), `POST /v2/bot/chat/loading/start` (`chatId`, `loadingSeconds` one of 5,10,...,60, default 20), `GET https://api-data.line.me/v2/bot/message/{messageId}/content` | `[CONFIRMED]` | reference |
| Quota endpoint: response `type` is `none` (no target limit set) or `limited` with `value`; the value is free plus additional messages; `quota/consumption` returns `totalUsage`, includes messages sent from LINE Official Account Manager and is **approximate** | `[CONFIRMED]` | reference, `#get-quota`, `#get-consumption` |
| What counts toward the quota: push, multicast, broadcast, narrowcast; **not** reply. Counted per recipient (a push to a five-person room is 5; message objects per request do not matter). A message to a user who blocked the account is not counted. Over the limit the API returns an error and the message is not sent | `[CONFIRMED]` | https://developers.line.biz/en/docs/messaging-api/pricing/ |
| Over-quota status code: **429** (also used for rate limits; the body says "You have reached your monthly limit."); the same 429 can appear even with messages left this month (see LINE FAQ) | `[CONFIRMED]` code, exact body wording `[VERIFY]` (live.ts maps it to `monthly_limit`) | reference, status codes |
| Rate limits: reply, push, quota endpoints 2,000 requests/s; loading animation 100 requests/s; 429 on excess. We do not hard-code them: `Retry-After` is honoured if LINE sends it, otherwise backoff | `[CONFIRMED]` numbers, `Retry-After` header `[VERIFY]` (not documented) | reference, "Rate limits" |
| Send limits: up to 5 message objects per request; text up to 5,000 characters (UTF-16 code units) | `[CONFIRMED]` | reference, text message object |
| Push conditions: friends, joined groups, or users who messaged within 7 days; blocked or deleted users still get 200 but nothing is delivered | `[CONFIRMED]` | reference, push message |
| Media: content is deleted "after a certain period" with no guarantee how long; large video / audio can answer **202** while being prepared; 404 / 410 if gone; `external` content providers cannot be fetched through this endpoint | `[CONFIRMED]` | reference, "Get content" |
| Mark as read needs only the token from the message event; there is no per-plan restriction in the reference | `[CONFIRMED]` API exists; availability for a given OA plan `[VERIFY]` (po #5: behind a flag until checked) | reference, `#mark-as-read` |

### Pricing (po #20: check against official pages before T-103 closes)

Read 2026-10-31 on the LINE for Business Thailand page
https://lineforbusiness.com/th/service/line-oa-features/broadcast-message (the Messaging API pricing page
https://developers.line.biz/en/docs/messaging-api/pricing/ links to the Thai plan page and lists no
Thai prices of its own; `https://www.linebiz.com/th/service/line-official-account/plan/` answered 404):

| Plan | Monthly fee (THB, excl. VAT 7%) | Free messages / month | Extra messages |
|---|---|---|---|
| Free | - | 300 | not available |
| Basic | 1,280 | 15,000 | 0.1 THB per message |
| Pro | 1,780 | 35,000 | 0.06 THB per message |

This matches PRD R-2.10 (300 / 15,000 at 1,280 / 35,000 at 1,780). Status: `[CONFIRMED]` against the
official LINE for Business Thailand page on the date above. Caveats that stay `[VERIFY]`:

- prices are as published on that date and can change; the page says they exclude 7% VAT;
- the page says the monthly plan cannot be bought on iOS (buy in LINE Official Account Manager);
- which time zone "this month" uses for the quota reset is not stated; `quotaPeriod()` takes the zone as
  a parameter (default `Asia/Bangkok`);
- the account's real limit comes from `GET /v2/bot/message/quota`; `FALLBACK_QUOTA_LIMIT = 300` is used
  only when LINE reports `type: none` (po #5 default).

## Design notes

- **Signature first.** `LineAdapter.ingest` verifies before parsing and throws `LineSignatureError`
  (the receiver answers 401 and writes nothing, ADR-009). A well-signed body that is not a LINE webhook throws
  `LineWebhookParseError`. An event inside a valid body that does not fit is reported in `rejected` by index
  (never with its content), so one odd event does not make LINE redeliver the others.
- **Unknown is kept.** Event types and message types this version does not know come through as
  `unsupported` with their `webhookEventId`, so the receiver still dedupes them.
- **External media URLs are dropped.** For `contentProvider.type = external` only the provider kind is
  surfaced; the URL is not, so nothing downstream can fetch an attacker-chosen URL (SSRF).
- **Router is a pure function** (`decideLineRoute`): token valid and unused gives `reply` (no quota); else `push`
  with a reason (`no_reply_token`, `reply_token_used`, `reply_token_expired`) and `quotaWarning` when this
  push would reach 80%; quota spent gives `none` / `quota_exhausted` / suggest `email` (PRD 8.3); an auto-ack
  (`pushFallback: 'deny'`) whose token is unusable gives `none` / `push_not_allowed` (ADR-010).
- **Retry policy per call** (`live.ts`): push is retried on timeout, network error, 5xx and 429 because
  the retry key makes it safe; reply is retried only after a 429 (a refused request), never after an unknown
  outcome; a monthly-limit 429 is not retried at all. After the budget is spent a `ChannelError` is thrown
  with `outcomeUnknown` / `retryable`; the outbox owns dead-lettering (ADR-006, ADR-010).
- **No secrets in output.** Errors carry status, operation, a stable `code` and the `X-Line-Request-Id`; never a
  token, a body, or LINE's free-text error message.
- **Egress hosts** are exactly the PRD section 11 list: `api.line.me` and `api-data.line.me`.

## Webhook receiver, media, auto-ack and identity (T-103 b-d)

Re-checked against https://developers.line.biz/en/docs/messaging-api/receiving-messages/ on 2026-11-01
`[CONFIRMED]`: the bot server must answer `2xx` (anything else triggers redelivery) and should process events
asynchronously; webhook redelivery is off by default and is switched on in the console (Messaging API tab:
"Use webhook", then "Webhook redelivery"); the number and interval of redeliveries are not disclosed; a
redelivered event is identical except `deliveryContext.isRedelivery`, and duplicates are detected with
`webhookEventId`; events may arrive out of order (use `timestamp`). The response time limit is not published
`[VERIFY]`, which is why the receiver does nothing slow. The signature header is `x-line-signature` (see above).

- **Receiver** `POST /v1/inbound/line/:channelAccountId` (apps/api): signature over the raw bytes first, then
  one `inbound_event` per event (unique on `webhookEventId`) plus an `ingest` outbox job in one transaction, then
  200. A redelivery hits the unique key and is answered 200. The channel secret comes from the credential store.
- **Media** (worker): images and files are fetched with `getContent` during ingestion and stored through the
  object store; video, audio and external image URLs are not fetched. 25 MiB cap `[ASSUMED]`.
- **Auto-ack** (worker): a new ticket on LINE is acknowledged with the reply token through the outbound pipeline
  (template `auto_ack.received` on the policy gate's safe list, never a push, no quota). Nothing is sent where the
  process has no LINE transport.
- **Identity**: link code (`WT-XXXXX-XXXXX`, 15 min, once) and LINE Login through `LineLoginProvider`. Only the
  fake provider exists; a live one is `[ASK-HUMAN]` (new network destination).

### Known limits (security review of T-103 b-d)

- **One channel secret per instance `[ASSUMED]`.** The credential store keeps one `line` integration (ADR-012), so
  the webhook secret is the same for every `:channelAccountId`: a body signed for one LINE Official Account is
  accepted at the URL of another. With a single Official Account (the Phase 1 case) there is nothing to cross.
  Binding the secret per account needs per-account credential keys in the store (a later task); until then do not
  register a second LINE account with a different secret. Since T-131 the API and the `channel-accounts` CLI enforce
  this: creating a second *active* LINE account is refused (409 / exit 1) until the first one is disabled, and a
  disabled account's webhook answers 401 like an unknown one.
- **Order of checks.** The failed-signature limiter is read first (a blocked address costs one Redis read), then the
  account, then the secret, then the HMAC. Only failures count, so LINE itself is never throttled.
- **Fake LINE Login** is off unless `LINE_LOGIN_FAKE_ENABLED=true`, which the config guard refuses in production, with
  LINE Login credentials set, or off a loopback `APP_URL`.
- **LINE identity verification** is kept apart from the contact's own `verified_at`: a staff-issued code links the LINE
  user but leaves `line_verified_at` empty (`line_linked_via = staff_code`); LINE Login from the portal session sets it.
  A code sent only to the contact's verified email (R-2.11 c, `email_code`) is not built yet: T-103e.
