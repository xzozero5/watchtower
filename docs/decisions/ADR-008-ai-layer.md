# ADR-008 — AI layer: ports, provider adapters, PII redaction และ audit record (T-106 a–c)

- **Status:** Proposed
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ร่างโดย `ai-engineer`; รอ `architect` + `security-reviewer` ตรวจตาม N7)
- **Context:** PRD §6 (หลักการ, agents, guardrails, provider config) และ §8.2 ต้องการ AI ที่ (1) read-only (N2) (2) redact PII ก่อนทุก LLM call (N4) (3) ลง audit ทุก action (prompt version, model, tools, input hash, output, cost, latency) (4) เลือก provider/model ผ่านหน้า admin (§6.7) · ADR-001 เลือก Vercel AI SDK · ADR-002 / `docs/04-ARCHITECTURE.md` §3 กำหนดให้ `packages/ai` ไม่รู้จัก HTTP และ DB/Redis (lint ห้าม global `fetch`, `Request`, `Response`, `Headers`) จึงต้องรับ port จาก `apps/api` / `apps/worker` · BACKLOG T-106 a–c ต้องปลดบล็อก T-107 (embedding) และ T-108 (tools) · `config/models.yaml` ใช้กับ AI ที่ build โปรเจกต์เท่านั้น (ADR-002) แต่คำว่า tier (`deep` / `standard` / `light`) ใช้เป็นภาษากลางได้

## Decision

### 1. Ports (ไฟล์ `packages/ai/src/contract.ts`)

`[ASSUMED]` ที่ตั้งชั่วคราว: `packages/shared/src/features/ai.ts` ยังไม่มีบน `main` (T-123a กำลังสร้าง) จึงวาง contract ไว้ใน `packages/ai` main thread ย้ายไป `packages/shared` ได้ภายหลัง (`ai` import `shared` ได้อยู่แล้ว) โดยไม่เปลี่ยน API

| Port                | หน้าที่                                                                                   | ผู้ implement                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `LlmProvider`       | `generate(LlmRequest) → LlmResponse` (text, finishReason, usage, model)                   | `MockLlmProvider`, `createAnthropicProvider`, `createVertexProvider`, `createVertexClaudeProvider` ใน `packages/ai`       |
| `EmbeddingProvider` | `embed(EmbeddingRequest) → { embeddings, usage }`                                         | `MockEmbeddingProvider`, `createVertexEmbeddingProvider`                                                                  |
| `AiRunSink`         | `record(AiRunRecord)` หนึ่งแถวต่อหนึ่ง model call (รวมที่ล้มเหลว)                         | `apps/api` / `apps/worker` เขียนตาราง `ai_run` (T-106d)                                                                   |
| `ToolRegistry`      | `register(tool)`, `scope({agent, intent, stage}) → ScopedTools` (`list`, `call`, `calls`) | `createToolRegistry(allowList)` ใน `packages/ai`; tool จริง (KB, similar tickets, GCP Logs, BigQuery, repo) เขียนใน T-108 |
| `SettingsSource`    | `load() → AiSettings` (provider/model ต่อ tier, tier ต่อ agent, embedding, ราคา)          | `apps/*` อ่านจาก DB (PRD §6.7); `mockSettings()` เป็นค่าเริ่มต้นเมื่อ `AI_PROVIDER=mock`                                  |

กฎของ port:

- ทุกฟิลด์ข้อความที่ไปถึง provider เป็น **`RedactedText`** (ดูข้อ 4) · `LlmResponse.text` เป็น string ธรรมดา อาจมี placeholder (`[EMAIL_1]`) ผู้เรียกเป็นคน restore เฉพาะใน view ที่คนเห็น
- port ไม่มี method ที่รับ string ดิบ และ `packages/ai` ไม่อ่าน `process.env`; `apps/*` อ่าน env แล้วส่ง config เข้ามา (`AI_PROVIDER` ว่างหรือ `mock` = mock, ขาด credential บางตัว = mock เหมือน `resolveIntegrationMode`)
- `createAuditedLlm({ settings, providers, sink })` เป็นทางเดียวที่ agent เรียก model: เลือก model ตาม tier → เรียก provider → สร้าง `AiRunRecord` → `sink.record` · **fail closed:** ถ้าเขียน audit ไม่ได้จะไม่คืนคำตอบ (`AuditWriteError`) · provider ล้มเหลวก็เขียนแถว `status: error` ก่อน rethrow

### 2. เลือก model ตาม tier

- ค่า tier ใช้คำเดียวกับ `config/models.yaml`: `deep` / `standard` / `light` · **ไม่มีชื่อ model จริงในโค้ด** (มี test สแกน string literal) · ชื่อ model เป็นค่าใน `AiSettings.tiers[tier] = { provider, model }` ที่ head ตั้งผ่านหน้า admin (T-106f)
- agent → tier ค่าเริ่มต้น `DEFAULT_AGENT_TIERS` `[ASSUMED]`: classifier/summarizer = `light`, investigator/drafter = `deep`, grader/kb_author/roster_planner/personal_assistant = `standard` · `AiSettings.agentTiers` override ต่อ agent · grader ใช้คนละ vendor ได้ด้วยการชี้ tier ของมันไปที่ provider อื่น (PRD §6.7)
- ราคาต่อ token อยู่ใน `AiSettings.prices` (keyed ด้วย model id) · ไม่มีราคา = `costUsd: null` (ไม่ทราบ ไม่ใช่ 0)
- `maxOutputTokens` ที่ไม่ระบุใช้ 1024 เพื่อกันค่าใช้จ่ายไม่จำกัด

### 3. Prompt แบบ versioned

- ไฟล์ `packages/ai/prompts/<id>.v<version>.md` มี front matter `id`/`version` ที่ต้องตรงกับชื่อไฟล์ · การเปลี่ยนพฤติกรรม = ไฟล์ version ใหม่ ไม่แก้ของเก่า
- `PromptRef = { id, version, hash }` โดย `hash` = sha256 ของเนื้อไฟล์ทั้งหมด (ต่างแค่ whitespace ก็ต่าง) · `parsePromptFile` / `renderPrompt` เป็นฟังก์ชัน pure (package ไม่ทำ I/O เอง; ตัวอ่านไฟล์เป็นของ T-106e) · slot ที่ไม่มีค่า = error
- ข้อความที่ render แล้วต้องผ่าน redactor ก่อนส่ง เพราะ slot อาจมี PII
- eval (T-302) ใช้ `PromptRef` ผูกผลกับเนื้อ prompt ที่ให้ผลนั้น

### 4. PII redaction (N4) บังคับด้วย compiler, provenance ของ token, normalisation และขีดจำกัดด้านเวลา

**ชนิดและการบังคับ**
- `RedactedText = string & { [brand] }` brand เป็น `unique symbol` ที่ไม่ export · จุด cast เดียวใน repo คือ `mintRedacted` ใน `redaction/redacted-text.ts` (มี `eslint-disable` หนึ่งบรรทัด และ `reportUnusedDisableDirectives` ทำให้ต้องใช้จริง) · ไม่ export จาก `index.ts` · `package.json` มี export เดียว (`.`) จึง deep import ไม่ได้ · test สแกนว่าไฟล์ที่ import `mintRedacted` มีเฉพาะ redactor
- **lint repo-wide (R-6):** `tools/eslint/boundaries.mjs` เพิ่ม `no-restricted-syntax` ให้ทุก workspace ห้าม `x as RedactedText`, `x as unknown as RedactedText`, `<RedactedText>x` และ `as RedactedText[]` (test ใน `tools/eslint/boundaries.test.mjs`) · alias (`type R = RedactedText; x as R`) ไม่ถูกจับ จึงยังต้อง review และ `security-reviewer` ใน T-114
- ทุก port รับเฉพาะ `RedactedText` · test ใช้ `// @ts-expect-error` พิสูจน์ว่าส่ง string ธรรมดาไป `LlmProvider.generate`, `EmbeddingProvider.embed`, `createAuditedLlm().generate` ไม่ compile
- **ทางเข้าเดียวของข้อความจาก model กลับเข้า prompt:** `session.fromModel(text)` — token ที่ session ออกให้คงไว้, สิ่งที่หน้าเหมือน token แต่ session ไม่เคยออกให้ถูก escape เป็น `[LITERAL_n]`, PII ใหม่ที่ model สร้างได้ token แบบ `model`

**Session, mapping และ provenance (R-2)**
- `createRedactor({ names, maxInputChars })` → `session({ scope, snapshot? })` โดย `scope` = ticket id · `snapshot()` คือ mapping `token → { value, origin, source? }` เก็บฝั่ง server (เข้ารหัส) ไม่ใส่ใน prompt/log/`ai_run` · snapshot ของ scope อื่นถูกปฏิเสธ (`RedactionScopeError`)
- `origin` มี 3 แบบ: `ticket` (ข้อความที่ผู้เกี่ยวข้องกับ ticket เขียนเอง ผ่าน `session.redact`), `tool` (ผลลัพธ์ tool ผ่าน `session.redactToolOutput(toolName, text)` เช่น ticket อื่น, KB, log), `model` (PII ที่ model เป็นผู้สร้าง) · ค่าเดียวกันได้ token เดียว และถ้า ticket เองมีค่านั้นด้วย origin จะเป็น `ticket`
- **`restore(text, audience = 'customer')` คืน `{ text, needsReview, unresolved }`:** `customer` (ค่าเริ่มต้น) restore เฉพาะ token ที่ origin เป็น `ticket`; `internal` (view ที่ staff เท่านั้นเห็น) restore ทุก token ที่รู้จัก · token ที่ไม่ restore (tool/model-origin หรือไม่เคยออกให้) ค้างเป็น token และ `needsReview = true` — **ร่างที่มีธงนี้ต้องส่งให้คนตรวจ ห้ามส่งหรือแสดงต่อลูกค้าแบบอัตโนมัติ** · เหตุผล: prompt injection ทำให้ model พิมพ์ token ใดก็ได้ที่เคยเห็น (เช่น `[EMAIL_2]` จาก ticket อื่นที่ tool คืนมา) ถ้า restore ไม่ดู origin จะเอา PII ของคนอื่นใส่ร่างถึงลูกค้า
- ข้อความที่ลูกค้าพิมพ์ให้หน้าเหมือน token ถูก escape เป็น `[LITERAL_n]` (origin `ticket`) จึงไม่ถูกอ่านเป็น token จริง และ `restore(redact(x), 'internal').text === x` เสมอ
- **ที่ T-108 ต้องทำตามนี้:** ผล tool ทุกชิ้นต้องผ่าน `redactToolOutput` ก่อนป้อนกลับ model; argument ที่ model ส่งเป็น token ต้อง restore แบบ `internal` เฉพาะการเรียก tool ที่อ่านอย่างเดียวและเฉพาะ token ของ ticket นี้; ข้อความถึงลูกค้าต้อง restore ด้วย `customer` และตรวจ `needsReview`

**ชนิดที่จับ**
- เลขบัตรประชาชนไทย 13 หลัก + checksum (หลักแรก 1–8), เบอร์โทร (มือถือ 06/08/09, 02, จังหวัด, `+66`/`0066`, `+CC` ทั่วไป), อีเมล, เลขบัตรเครดิต (13–19 หลักผ่าน Luhn), เลขบัญชีธนาคาร `[ASSUMED]` (รูปแบบ 123-4-56789-0 / 123-456789-0 และเลขล้วนหลัง keyword บัญชี/account/acct/acc no./a/c), ชื่อจาก dictionary
- placeholder `[EMAIL_n]`, `[PHONE_n]`, `[THAI_ID_n]`, `[CARD_n]`, `[BANK_n]`, `[NAME_n]`, `[LITERAL_n]`

**Normalisation (R-5)**
- detector สแกน "view" ที่ normalise แล้ว (`redaction/normalize.ts`): NFKC ต่อ cluster (ตัวฐาน + combining mark จึงประกอบ NFD กลับเป็น NFC; full-width `＋ ＠ ０-９`, NBSP/space พิเศษ → ASCII), ตัด `\p{Cf}` (zero-width, soft hyphen, bidi), แปลงทุก `\p{Nd}` (ไทย, อารบิก-อินดิก, เทวนาครี, ...) เป็น 0-9, case-fold สำหรับชื่อ · มี index map กลับไปตำแหน่งในสตริงต้นฉบับ แล้วแทนที่บนสตริงต้นฉบับ จึงไม่เสีย round trip
- ตัวเลข: รวม digit run ที่คั่นด้วย `[ - . / – — − ( )]` ไม่เกิน 3 ตัว (รวมเว้นวรรคซ้ำ) เป็น cluster แล้วทดสอบ window ของกลุ่มตัวเลข ไม่เกิน 8 กลุ่ม/19 หลัก: เบอร์ `08-1234-5678`, `081.234.5678`, `(02) 123 4567`, `call0812345678`, `+1 (415) 555-0100`; บัตรคั่นด้วย `.` `/` ได้; ตัวคั่นในเบอร์ต้องเป็นชนิดเดียวกัน (กัน `08/10/2026 12` ถูกอ่านเป็นเบอร์)
- อีเมล: เดินออกจาก `@` ด้วยขีดจำกัด (local 64, domain 255); local part ภาษาไทย/Unicode และโดเมน IDN รองรับ ยกเว้นอักษรไทยในโดเมน `[ASSUMED]` (ไม่งั้น "example.comครับ" จะถูกกลืน)
- ชื่อ: จับบน view ที่ case-fold ทั้งสองฝั่ง ดังนั้น NFC/NFD และตัวพิมพ์ต่างกันตรงกัน

**ขีดจำกัดด้านประสิทธิภาพ (R-3, R-4)** — regex แบบ restart กลางสายยาว (เช่น local part ของอีเมล) ให้ O(n²) (200 KB ≈ 39 วินาทีก่อนแก้)
- ไม่มี regex ที่ backtrack บน input ไม่จำกัด: ตัวเลขใช้ scan เดียวซ้าย→ขวา, อีเมลใช้ `indexOf('@')` + ขีดจำกัด, ชื่อใช้ Aho–Corasick (เขียนเอง ไม่มี dependency) แก้ O(text × names) · resolve ทับซ้อนด้วย marker array เป็นเชิงเส้น
- `maxInputChars` (ค่าเริ่มต้น 1,000,000) เกินแล้วปฏิเสธ (`RedactionInputTooLargeError`) — fail closed; ผู้เรียกต้องแบ่ง/ตัดก่อน
- **ผู้เรียกต้องส่ง dictionary ที่ scope แล้ว** (contact ขององค์กรนั้น / ผู้เกี่ยวข้องกับ ticket) ไม่ใช่ทุก contact ในระบบ: dictionary สร้างใหม่ทุก session และเกิน 50,000 รายการถูกปฏิเสธ (`DictionaryTooLargeError`)
- test: input 200 KB × 30 รูปแบบ (ตัวอักษร/ตัวเลข/คั่น/`@`/token/keyword/`+`/zero-width/combining mark/ไทย) ต้องใช้เวลา < 200 ms (ดีที่สุดใน 3 รอบ; วัดจริง 10–160 ms) และ dictionary 10,000 ชื่อ × ข้อความ 100 KB < 1 วินาที (วัดจริง ~0.3–0.5 วินาที)


### 5. Provider adapters (Vercel AI SDK `ai@7.0.159`, `@ai-sdk/anthropic@4.0.94`, `@ai-sdk/google-vertex@5.0.129`)

- ฉีด `fetch` ทุกตัว (`FetchLike = typeof globalThis.fetch` ผ่าน `globalThis.` เพราะ lint ห้าม bare `fetch`) · test เล่น fixture ผ่าน `createReplayFetch` และตรวจว่า global `fetch` ไม่ถูกเรียก
- **ปฏิเสธ construct ถ้า config ไม่ครบ** (`ProviderConfigError`): anthropic ต้องมี `apiKey` + `fetch`; vertex ต้องมี `auth` แบบชัดเจน — `{ kind: 'apiKey' }` (express mode) หรือ `{ kind: 'accessToken', project, location, getAccessToken }` · **ไม่มี ADC probing** และไม่ fallback ไป env (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `GOOGLE_VERTEX_*`) เพราะส่ง baseURL/ค่าทุกตัวแบบ explicit
- ใช้ entry `@ai-sdk/google-vertex/edge` และ `/anthropic/edge` เท่านั้น เพราะ entry ปกติ import `google-auth-library` และสร้าง `GoogleAuth` ตอน import (ซึ่งหา credential โดยไล่ env → ไฟล์ → GCE metadata server) · แต่ token helper ของ edge เรียก global `fetch` ที่เราฉีดไม่ได้ จึงไม่ใช้: โหมด OAuth ใช้ express path ของ SDK กับ placeholder key แล้วสลับ header เป็น `Authorization: Bearer <getAccessToken()>` ใน wrapper ของเรา (`viaBearerToken`) — `vertex.test.ts` ตรึง request จริงที่ถึง `fetch` (URL, header) เพื่อให้ SDK อัปเดตแล้ว test ล้มทันที · Claude บน Vertex ใช้ `generateAuthToken` ที่ SDK รองรับตรง ๆ
- `telemetry: { isEnabled: false }` ทุก call; ไม่เคยเรียก `registerTelemetry` · ไม่ส่ง model เป็น string (จะไปทาง Vercel AI Gateway) มีแต่ model object จาก adapter ของเรา
- ผู้เรียก (`apps/*`) เป็นคนสร้าง `getAccessToken` (เช่น service account จาก credential store ADR-004) · `packages/ai` ไม่มี token source ของตัวเอง
- **ตรวจ network ตอน import (`[TESTED]`):** import ผ่าน `dist` ใน process ที่ trap `net`, `tls`, `dns`, `fetch` → 0 ครั้ง, ไม่มี global telemetry integration, และ module hook ยืนยันว่า `google-auth-library`/`gcp-metadata`/`gaxios` ไม่ถูกโหลดเลย (control: entry ปกติโหลด) · ทำซ้ำเป็น vitest ใน `import-safety.test.ts`
- Mock (`AI_PROVIDER=mock` ค่าเริ่มต้น): คำตอบเลือกจาก (prompt id, hash ของ input) — rule แบบ exact → rule ต่อ prompt → ข้อความ placeholder deterministic · `strict: true` เพื่อให้ test ล้มเมื่อไม่มี rule · ไม่เปิด socket

### 6. Tool registry (N2)

- `ToolDefinition.readOnly: true` เป็น literal type (declare tool ที่เขียนไม่ได้) และ `register` ตรวจ runtime ซ้ำ · ทุก tool มี Zod `input`/`output` ที่ตรวจทุก call
- allow-list เป็นข้อมูล: `{ agent | '*', intent | '*', stages?, tools[] }` **deny by default** · intent `null` (ก่อน classify) ตรงเฉพาะ rule `'*'` · `scope()` ให้ handle ต่อหนึ่ง run ที่ `list()` เห็นเฉพาะ tool ที่ได้สิทธิ์, `call()` ปฏิเสธนอก scope (`ToolNotAllowedError`) และมี budget ต่อ run (ค่าเริ่มต้น 20 call → `ToolBudgetError`) · `calls()` คืน `{name, inputHash, ok, latencyMs, errorCode}` ไปใส่ `AiRunRecord.tools`
- **budget ต่อ run/ticket อยู่นอก handle (ยังไม่ทำ — T-108):** `maxCalls` ของ `scope()` นับต่อ handle เท่านั้น ผู้เรียกที่สร้าง `scope()` ใหม่ได้ budget ใหม่ จึงยังไม่ใช่เพดานต่อ ticket · T-108a ต้องเพิ่ม budget ที่ผู้เรียกเป็นเจ้าของ (นับต่อ run id และต่อ ticket/วัน ที่เก็บนอก handle เช่น `tool_execution`) และ rate limit ต่อ tool ก่อนต่อ tool จริงตัวแรก
- ชั้นบังคับจริงของ "อ่านอย่างเดียว" ที่ฐานข้อมูล/GCP คือ role `watchtower_ai_ro` และ IAM ตาม PRD §8.2 (T-108a) — registry เป็นชั้นป้องกันเพิ่ม ไม่ใช่ชั้นเดียว

### 7. Audit record (`AiRunRecord`, Zod) — ตาราง `ai_run` ใน T-106d

`agent, provider, model, tier, prompt{id,version,hash}, tools[], inputHash (HMAC-SHA-256 ของ input ที่ redact แล้ว), output (คำตอบในรูป placeholder; null เมื่อ error), confidence (0..1|null), redaction{total, byKind}, inputTokens, outputTokens, costUsd (null=ไม่ทราบ), latencyMs, status (ok|error), errorCode (ชื่อ class เท่านั้น), intent, ticketId, startedAt` · **ไม่เก็บ input, ค่า PII เดิม หรือ message ของ error**

- **`inputHash` เป็น HMAC (R-7):** key = `AiSettings.inputHashKey` (≥ 32 ตัวอักษร, secret ฝั่ง server จาก env/credential store, ไม่ log) · redaction มีช่องว่าง input จึงอาจมี PII เหลือ และ sha256 ธรรมดาของข้อความสั้นถูก brute force ย้อนได้ · HMAC ใช้ได้แค่ถามว่า "input เดียวกันไหม" สำหรับผู้ถือ key · `hashLlmInput` (ไม่มี key) ยังอยู่แต่ใช้จับคู่ rule ของ mock เท่านั้น ไม่ export จาก package และไม่เก็บ
- **ตรวจก่อนเรียก provider (R-1):** `createAuditedLlm` สร้าง record ส่วนที่รู้แล้ว (agent, model, prompt ref, inputHash, redaction, ticket) แล้ว validate ด้วย Zod **ก่อนเรียก provider** — prompt hash ผิดรูป/version 0/ค่านับติดลบ ล้มด้วย `AuditInputError` โดยไม่เสียเงิน · หลังเรียกแล้วจะมีแถวเสมอ: `confidence` นอกช่วงถูก clamp (NaN/ไม่ใช่ตัวเลข/throw → null), `toolCalls` ที่ throw → `[]`, usage แปลก ๆ → 0 · ถ้า record ยังไม่ผ่าน schema จะเขียนแถว `status: 'error'` แบบ minimal (`errorCode: 'AuditRecordInvalid'`) แล้ว throw `AuditRecordError` · เขียนแถวไม่ได้ → `AuditWriteError` (fail closed) · test ยืนยัน "จำนวนครั้งเรียก provider = จำนวนแถว" ทุกเส้นทาง (ยกเว้น provider ไม่ได้ตั้งค่า: เขียนแถว error โดยไม่มีการเรียก)
- T-106d เพิ่ม: partition รายเดือน, immutable (ไม่มี UPDATE/DELETE), cap ต่อวัน, เตือน 80%, kill switch · หมายเหตุจาก `docs/04-ARCHITECTURE.md` §7: `ai_draft.ai_run_id` ต้องตัดสินเรื่อง PK `(id, created_at)` ตอนทำ T-106d

## Options considered

- **A — SDK ของ vendor ตรง ๆ (`@anthropic-ai/sdk`, `@google-cloud/vertexai`)** — ควบคุมได้มากกว่า แต่ขัด ADR-001 และต้องทำ abstraction + tool-loop เอง
- **B — Vercel AI SDK ผ่าน port ของเรา (เลือก)** — ตาม ADR-001; port บางทำให้เปลี่ยน/ปิด SDK ได้ และ mock ไม่ต้องพึ่ง SDK
- **C — entry ปกติของ `@ai-sdk/google-vertex` + `google-auth-library`** — auth ครบกว่า (service account, workload identity) แต่โหลด library ที่ probe credential และ token exchange ไม่ผ่าน `fetch` ที่ฉีด → ทดสอบแบบ offline ไม่ได้ และขัดกฎ "ไม่ probe ADC" · ไม่เลือก; ผู้เรียกให้ `getAccessToken` เองได้ (รวมถึงสร้างด้วย `google-auth-library` ใน `apps/*` ถ้าต้องการ)
- **D — `RedactedText` เป็นแค่ convention + lint** — ผ่อนปรนได้ด้วย `eslint-disable` · ไม่เลือกอย่างเดียว; ใช้ brand type + `@ts-expect-error` test (typecheck ล้มทันที) **ร่วมกับ** lint ห้าม cast (R-6)
- **E — redact ภายใน adapter ของ provider** — ผู้เรียกไม่ต้องคิด แต่ mapping ต้องรอดผ่าน tool loop และ restore ต้องอยู่คนละที่กับ adapter · ไม่เลือก; ให้ redact ที่ขอบ agent แล้ว port บังคับด้วยชนิด

## Consequences

- **ช่องว่างของ redaction ที่รู้ (ต้องไม่อ้างว่าครบ):** (1) ชื่อที่ไม่อยู่ใน dictionary ไม่ถูกจับ — ไม่มี NER; PRD ระบุ "names where possible" (2) ที่อยู่, เลขพาสปอร์ต, ทะเบียนรถ, LINE userId, IP, รูป/เอกสารสแกนไม่ถูกจับ (รูปเป็นงานแยกตาม PRD §6.6) (3) เลข 13 หลักที่บังเอิญผ่าน checksum (เช่น epoch มิลลิวินาที) และเลข 13–19 หลักที่ผ่าน Luhn จะถูก redact เกิน (ทิศที่ปลอดภัย) (4) ชื่อไทยสั้นใน dictionary อาจ redact ภายในคำที่ยาวกว่า (ไทยไม่มีช่องว่าง) ตั้ง `minNameLength = 3`; local part ภาษาไทยที่ติดกับคำไทยอื่นจะกลืนทั้งคำ (over-redact) (5) รูปแบบบัญชีธนาคารเป็น `[ASSUMED]` ยังไม่ตรวจกับธนาคารจริง และเลขล้วนที่ไม่มี keyword ไม่ถูกจับ (6) ตัวเลขที่สะกดเป็นคำ ("ศูนย์แปดหนึ่ง...") หรือคั่นด้วยตัวคั่นนอกชุด (เช่น `:` `,` ขึ้นบรรทัดใหม่) หรือคั่นเกิน 3 ตัวไม่ถูกจับ; โดเมนอีเมลที่เป็นอักษรไทยไม่ถูกจับ; อีเมลแบบ obfuscate (`a [at] b.com`) ไม่ถูกจับ (7) ตัวเลขที่ถูกตัดข้าม chunk ของผู้เรียก (เพราะเราไม่ chunk เอง — เกิน `maxInputChars` ถูกปฏิเสธ) (8) cast ผ่าน alias ของ `RedactedText` ข้าม lint rule ได้ — ตรวจตอน review และ `security-reviewer` ใน T-114
- **lint rule (R-6):** การ cast ไป `RedactedText` ถูกห้ามทั้ง repo ด้วย `tools/eslint/boundaries.mjs` (ทุก workspace) ยกเว้นจุด mint เดียว · เพิ่ม workspace ใหม่ในตาราง `WORKSPACES` ก็ได้กฎนี้อัตโนมัติ
- **Follow-up จาก security review (ยังไม่ทำใน a–c):** R-8, R-9, R-10 (P2/P3) ถูกส่งต่อให้ T-108 / T-106d ตามบันทึก review `docs/security-reviews/2026-11-01-T-106-ai-layer.md` (SR106-R8…R10) · round 2 พบ N1–N6 (P2/P3) → T-126 · ข้อความ "lint ทุก workspace" ยังไม่จริงใน `apps/api` จนกว่า SR106-N1 จะแก้ · budget ต่อ run/ticket นอก handle ดู §6 · ตัวอ่านไฟล์ prompt (I/O) และ `ai_run` จริงอยู่ T-106d/e
- **ต้องมี eval ของ redaction recall** กับข้อความจริงที่ anonymize แล้วก่อนเปิด stage ≥ 1 (T-302) · ตอนนี้มีแค่ unit + property test
- fixture ของ provider เขียนมือจากรูปแบบ response ที่ SDK parse ได้ **ไม่ใช่ที่บันทึกจาก live** `[UNVERIFIED 70%]` ว่าตรงกับ wire format จริงทุกกรณี · live check ครั้งแรกเป็น `[ASK-HUMAN]` (ต้องมี key, ผ่าน budget guard `app_ai_dev` ใน `config/budgets.yaml`)
- โหมด OAuth ของ Vertex Gemini พึ่งพฤติกรรม express-mode ของ SDK (placeholder key + สลับ header) — ผูกกับเวอร์ชัน SDK ที่ตรึงใน lockfile; test ตรึง request จริง · ถ้า SDK เพิ่ม hook รับ token ตรง ๆ ให้เปลี่ยน
- dependency ใหม่ 33 แพ็กเกจ ตรึงเวอร์ชันตรงตัว (R-11: `ai@7.0.159`, `@ai-sdk/anthropic@4.0.94`, `@ai-sdk/google-vertex@5.0.129` ไม่มี `^`; `pins.test.ts` ตรวจ) (ผ่าน `ai`, `@ai-sdk/*`; `google-auth-library` มากับ `@ai-sdk/google-vertex` แต่ไม่ถูกโหลด) ไม่มี install script · ปลายทางเครือข่ายใหม่ที่ SDK เรียกได้ถ้าถูกใช้: `api.anthropic.com`, `*-aiplatform.googleapis.com` (เมื่อ caller ฉีด `fetch` จริงและมี credential เท่านั้น) · import `@watchtower/ai` โหลด SDK ทั้งชุดแม้ใช้แค่ mock (ย้ายเป็น subpath export ได้ถ้าเวลา start ของ worker เป็นปัญหา)
- งานต่อ: T-106d (ตาราง `ai_run`, caps, kill switch), T-106e (classifier/summarizer + prompt ไฟล์แรก + ตัวอ่านไฟล์ prompt), T-106f (settings API + secret ผ่าน T-116)
- ทบทวนซ้ำเมื่อ: SDK major ใหม่, ต้องรองรับ provider ที่สาม (OpenAI-compatible), หรือพบ PII หลุดใน eval

## Links

- PRD §6.1–6.7, §8.2 · BACKLOG T-106, T-107, T-108, T-112 · `docs/plans/phase-1-breakdown.md` §D, §F.3 · ADR-001, ADR-002, ADR-004 · `docs/04-ARCHITECTURE.md` §3, §7
- ตรวจ source ของ SDK ใน `node_modules` เมื่อ 2026-11-01: `ai@7.0.159` (`sideEffects: false`, telemetry เปิดเฉพาะเมื่อ `registerTelemetry`), `@ai-sdk/google-vertex@5.0.129` (entry ปกติ `new GoogleAuth()` ตอน import; `/edge` ไม่ import `google-auth-library`), `@ai-sdk/anthropic@4.0.94` (อ่าน `ANTHROPIC_*` เฉพาะเมื่อไม่ส่งค่า)
