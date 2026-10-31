# ADR-008 — AI layer: ports, provider adapters, PII redaction และ audit record (T-106 a–c)

- **Status:** Proposed
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ร่างโดย `ai-engineer`; รอ `architect` + `security-reviewer` ตรวจตาม N7)
- **Context:** PRD §6 (หลักการ, agents, guardrails, provider config) และ §8.2 ต้องการ AI ที่ (1) read-only (N2) (2) redact PII ก่อนทุก LLM call (N4) (3) ลง audit ทุก action (prompt version, model, tools, input hash, output, cost, latency) (4) เลือก provider/model ผ่านหน้า admin (§6.7) · ADR-001 เลือก Vercel AI SDK · ADR-002 / `docs/04-ARCHITECTURE.md` §3 กำหนดให้ `packages/ai` ไม่รู้จัก HTTP และ DB/Redis (lint ห้าม global `fetch`, `Request`, `Response`, `Headers`) จึงต้องรับ port จาก `apps/api` / `apps/worker` · BACKLOG T-106 a–c ต้องปลดบล็อก T-107 (embedding) และ T-108 (tools) · `config/models.yaml` ใช้กับ AI ที่ build โปรเจกต์เท่านั้น (ADR-002) แต่คำว่า tier (`deep` / `standard` / `light`) ใช้เป็นภาษากลางได้

## Decision

### 1. Ports (ไฟล์ `packages/ai/src/contract.ts`)
`[ASSUMED]` ที่ตั้งชั่วคราว: `packages/shared/src/features/ai.ts` ยังไม่มีบน `main` (T-123a กำลังสร้าง) จึงวาง contract ไว้ใน `packages/ai` main thread ย้ายไป `packages/shared` ได้ภายหลัง (`ai` import `shared` ได้อยู่แล้ว) โดยไม่เปลี่ยน API

| Port | หน้าที่ | ผู้ implement |
|---|---|---|
| `LlmProvider` | `generate(LlmRequest) → LlmResponse` (text, finishReason, usage, model) | `MockLlmProvider`, `createAnthropicProvider`, `createVertexProvider`, `createVertexClaudeProvider` ใน `packages/ai` |
| `EmbeddingProvider` | `embed(EmbeddingRequest) → { embeddings, usage }` | `MockEmbeddingProvider`, `createVertexEmbeddingProvider` |
| `AiRunSink` | `record(AiRunRecord)` หนึ่งแถวต่อหนึ่ง model call (รวมที่ล้มเหลว) | `apps/api` / `apps/worker` เขียนตาราง `ai_run` (T-106d) |
| `ToolRegistry` | `register(tool)`, `scope({agent, intent, stage}) → ScopedTools` (`list`, `call`, `calls`) | `createToolRegistry(allowList)` ใน `packages/ai`; tool จริง (KB, similar tickets, GCP Logs, BigQuery, repo) เขียนใน T-108 |
| `SettingsSource` | `load() → AiSettings` (provider/model ต่อ tier, tier ต่อ agent, embedding, ราคา) | `apps/*` อ่านจาก DB (PRD §6.7); `mockSettings()` เป็นค่าเริ่มต้นเมื่อ `AI_PROVIDER=mock` |

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

### 4. PII redaction (N4) บังคับด้วย compiler
- `RedactedText = string & { [brand] }` brand เป็น `unique symbol` ที่ไม่ export · ฟังก์ชันสร้าง (`mintRedacted`) อยู่ใน `redaction/redacted-text.ts`, ไม่ export ออก package และ test สแกนว่ามีเฉพาะ `redactor.ts` ที่ import · `package.json` มี export เดียว (`.`) จึง deep import ไม่ได้
- ทุก port รับเฉพาะ `RedactedText` · test ใช้ `// @ts-expect-error` พิสูจน์ว่าส่ง string ธรรมดาไป `LlmProvider.generate`, `EmbeddingProvider.embed`, `createAuditedLlm().generate` ไม่ compile (typecheck จึงล้มถ้ามีใครผ่อนกฎ)
- `createRedactor({ names })` → `session()` ต่อหนึ่ง prompt (หรือหนึ่ง ticket ถ้าต้อง restore ทีหลัง) · `session.redact(text)`, `session.restore(text)`, `session.mapping()` (token → ค่าเดิม เก็บฝั่ง server เข้ารหัส ไม่ใส่ใน prompt/log/`ai_run`), `session.report()` (จำนวนต่อชนิด ไม่มีค่าเดิม)
- ชนิดที่จับ: เลขบัตรประชาชนไทย 13 หลัก + checksum (หลักแรก 1–8), เบอร์โทรไทย/ต่างประเทศ (มือถือ 06/08/09, 02, จังหวัด, +66/0066, +CC), อีเมล, เลขบัตรเครดิต (13–19 หลักผ่าน Luhn, รวมแบบแบ่งกลุ่ม), เลขบัญชีธนาคาร `[ASSUMED]` (รูปแบบ 123-4-56789-0 / 123-456789-0 และเลขล้วนหลัง keyword บัญชี/account/a/c), ชื่อจาก dictionary ที่ระบบรู้จัก (contact/org member) · เลขไทย (๐–๙) และ full-width ถูกแปลงเป็น ASCII ก่อนจับโดย offset ไม่เปลี่ยน
- placeholder `[EMAIL_1]`, `[PHONE_1]`, `[THAI_ID_1]`, `[CARD_1]`, `[BANK_1]`, `[NAME_1]` · ค่าเดียวกันได้ token เดียวภายใน session · ข้อความที่หน้าตาเหมือน token อยู่แล้วถูก escape เป็น `[LITERAL_n]` เพื่อให้ `restore(redact(x)) === x` เสมอและ restore ไม่ขยายสิ่งที่ลูกค้าพิมพ์เอง
- **ข้อควรระวังที่ T-108 ต้องทำ:** ผลลัพธ์ของ tool ที่ป้อนกลับเข้า model ต้องผ่าน session เดียวกันก่อน (tool อาจคืนข้อความลูกค้าดิบ) และ argument ที่ model ส่งมาเป็น token ต้อง restore ก่อนเรียก tool
- ช่องว่างที่รู้: ดู "Consequences"

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
- ชั้นบังคับจริงของ "อ่านอย่างเดียว" ที่ฐานข้อมูล/GCP คือ role `watchtower_ai_ro` และ IAM ตาม PRD §8.2 (T-108a) — registry เป็นชั้นป้องกันเพิ่ม ไม่ใช่ชั้นเดียว

### 7. Audit record (`AiRunRecord`, Zod) — ตาราง `ai_run` ใน T-106d
`agent, provider, model, tier, prompt{id,version,hash}, tools[], inputHash (sha256 ของ input ที่ redact แล้ว), output (คำตอบในรูป placeholder; null เมื่อ error), confidence (0..1|null), redaction{total, byKind}, inputTokens, outputTokens, costUsd (null=ไม่ทราบ), latencyMs, status (ok|error), errorCode (ชื่อ class เท่านั้น), intent, ticketId, startedAt` · **ไม่เก็บ input, ค่า PII เดิม หรือ message ของ error** · T-106d เพิ่ม: partition รายเดือน, immutable (ไม่มี UPDATE/DELETE), cap ต่อวัน, เตือน 80%, kill switch · หมายเหตุจาก `docs/04-ARCHITECTURE.md` §7: `ai_draft.ai_run_id` ต้องตัดสินเรื่อง PK `(id, created_at)` ตอนทำ T-106d

## Options considered
- **A — SDK ของ vendor ตรง ๆ (`@anthropic-ai/sdk`, `@google-cloud/vertexai`)** — ควบคุมได้มากกว่า แต่ขัด ADR-001 และต้องทำ abstraction + tool-loop เอง
- **B — Vercel AI SDK ผ่าน port ของเรา (เลือก)** — ตาม ADR-001; port บางทำให้เปลี่ยน/ปิด SDK ได้ และ mock ไม่ต้องพึ่ง SDK
- **C — entry ปกติของ `@ai-sdk/google-vertex` + `google-auth-library`** — auth ครบกว่า (service account, workload identity) แต่โหลด library ที่ probe credential และ token exchange ไม่ผ่าน `fetch` ที่ฉีด → ทดสอบแบบ offline ไม่ได้ และขัดกฎ "ไม่ probe ADC" · ไม่เลือก; ผู้เรียกให้ `getAccessToken` เองได้ (รวมถึงสร้างด้วย `google-auth-library` ใน `apps/*` ถ้าต้องการ)
- **D — `RedactedText` เป็นแค่ convention + lint** — ผ่อนปรนได้ด้วย `eslint-disable` · ไม่เลือก; brand type + `@ts-expect-error` test ทำให้ typecheck ล้มทันที
- **E — redact ภายใน adapter ของ provider** — ผู้เรียกไม่ต้องคิด แต่ mapping ต้องรอดผ่าน tool loop และ restore ต้องอยู่คนละที่กับ adapter · ไม่เลือก; ให้ redact ที่ขอบ agent แล้ว port บังคับด้วยชนิด

## Consequences
- **ช่องว่างของ redaction ที่รู้ (ต้องไม่อ้างว่าครบ):** (1) ชื่อที่ไม่อยู่ใน dictionary ไม่ถูกจับ — ไม่มี NER; PRD ระบุ "names where possible" (2) ที่อยู่, เลขพาสปอร์ต, ทะเบียนรถ, LINE userId, IP, รูป/เอกสารสแกนไม่ถูกจับ (รูปเป็นงานแยกตาม PRD §6.6) (3) เลข 13 หลักที่บังเอิญผ่าน checksum (เช่น epoch มิลลิวินาที) และเลข 13–19 หลักที่ผ่าน Luhn จะถูก redact เกิน (ทิศที่ปลอดภัย) (4) ชื่อไทยสั้นใน dictionary อาจ redact ภายในคำที่ยาวกว่า (ไทยไม่มีช่องว่าง) ตั้ง `minNameLength = 3` (5) รูปแบบบัญชีธนาคารเป็น `[ASSUMED]` ยังไม่ตรวจกับธนาคารจริง และเลขล้วนที่ไม่มี keyword ไม่ถูกจับ (6) ไม่ normalize Unicode (NFC/NFD) ชื่อใน dictionary ที่ต่างรูปจากข้อความจึงอาจพลาด (7) ตัวเลขที่ถูกพิมพ์แยกด้วยตัวคั่นแปลก ๆ หรือสะกดเป็นคำ ("ศูนย์แปดหนึ่ง...") ไม่ถูกจับ (8) brand type กันได้เฉพาะ compile-time: โค้ดที่ cast `as RedactedText` เองข้ามได้ — ตรวจตอน review และ `security-reviewer` ใน T-114
- **ต้องมี eval ของ redaction recall** กับข้อความจริงที่ anonymize แล้วก่อนเปิด stage ≥ 1 (T-302) · ตอนนี้มีแค่ unit + property test
- fixture ของ provider เขียนมือจากรูปแบบ response ที่ SDK parse ได้ **ไม่ใช่ที่บันทึกจาก live** `[UNVERIFIED 70%]` ว่าตรงกับ wire format จริงทุกกรณี · live check ครั้งแรกเป็น `[ASK-HUMAN]` (ต้องมี key, ผ่าน budget guard `app_ai_dev` ใน `config/budgets.yaml`)
- โหมด OAuth ของ Vertex Gemini พึ่งพฤติกรรม express-mode ของ SDK (placeholder key + สลับ header) — ผูกกับเวอร์ชัน SDK ที่ตรึงใน lockfile; test ตรึง request จริง · ถ้า SDK เพิ่ม hook รับ token ตรง ๆ ให้เปลี่ยน
- dependency ใหม่ 33 แพ็กเกจ (ผ่าน `ai`, `@ai-sdk/*`; `google-auth-library` มากับ `@ai-sdk/google-vertex` แต่ไม่ถูกโหลด) ไม่มี install script · ปลายทางเครือข่ายใหม่ที่ SDK เรียกได้ถ้าถูกใช้: `api.anthropic.com`, `*-aiplatform.googleapis.com` (เมื่อ caller ฉีด `fetch` จริงและมี credential เท่านั้น) · import `@watchtower/ai` โหลด SDK ทั้งชุดแม้ใช้แค่ mock (ย้ายเป็น subpath export ได้ถ้าเวลา start ของ worker เป็นปัญหา)
- งานต่อ: T-106d (ตาราง `ai_run`, caps, kill switch), T-106e (classifier/summarizer + prompt ไฟล์แรก + ตัวอ่านไฟล์ prompt), T-106f (settings API + secret ผ่าน T-116)
- ทบทวนซ้ำเมื่อ: SDK major ใหม่, ต้องรองรับ provider ที่สาม (OpenAI-compatible), หรือพบ PII หลุดใน eval

## Links
- PRD §6.1–6.7, §8.2 · BACKLOG T-106, T-107, T-108, T-112 · `docs/plans/phase-1-breakdown.md` §D, §F.3 · ADR-001, ADR-002, ADR-004 · `docs/04-ARCHITECTURE.md` §3, §7
- ตรวจ source ของ SDK ใน `node_modules` เมื่อ 2026-11-01: `ai@7.0.159` (`sideEffects: false`, telemetry เปิดเฉพาะเมื่อ `registerTelemetry`), `@ai-sdk/google-vertex@5.0.129` (entry ปกติ `new GoogleAuth()` ตอน import; `/edge` ไม่ import `google-auth-library`), `@ai-sdk/anthropic@4.0.94` (อ่าน `ANTHROPIC_*` เฉพาะเมื่อไม่ส่งค่า)
