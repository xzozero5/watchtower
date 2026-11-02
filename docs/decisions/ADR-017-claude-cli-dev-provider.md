# ADR-017 — Provider `claude-cli`: ใช้ Claude Code CLI ในเครื่องเจ้าของสำหรับ dev/POC

- **Status:** Accepted (เฉพาะ dev/POC)
- **Date:** 2026-11-02 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของโปรเจกต์ (สั่งให้ทำ POC ด้วย CLI แทน API key)
- **Context:** เจ้าของต้องการทดสอบ AI layer บนเครื่องตัวเองโดยไม่มี Anthropic API key ใช้ `claude -p` ของ Claude Code ที่ login ด้วย subscription อยู่แล้ว (CLI 2.1.316 ติดตั้งแล้ว `[TESTED]` จาก `claude --help`) ปัญหา: worker รันใน Docker Desktop บน Windows จึง spawn `claude` ไม่ได้ · ต้องรักษา N2 (tool read-only), N4 (redact ก่อนเรียก), `ai_run` ทุก call, daily cap + kill switch, ไม่ fallback เป็น mock เงียบ ๆ (ADR-008, T-132)

## Decision
1. **provider kind ใหม่ `claude-cli`** (`PROVIDER_KINDS`, `AI_PROVIDERS`) เป็น dev/POC เท่านั้น: config validation (`packages/shared`) ปฏิเสธ boot เมื่อ `NODE_ENV=production` **หรือ** `APP_URL` ไม่ใช่ loopback (กัน instance ที่คนอื่นเข้าถึงได้ส่งข้อความลูกค้าผ่าน subscription ส่วนตัวคนเดียว)
2. **Bridge ฝั่ง host** `tools/claude-cli-bridge/` (Node ล้วน ไม่มี dependency ใหม่) เริ่มด้วย `pnpm claude-bridge` ฟังที่ `127.0.0.1:4317` (ปรับได้ด้วย `CLAUDE_CLI_BRIDGE_PORT/HOST`) ต้องมี bearer token (`CLAUDE_CLI_BRIDGE_TOKEN` ≥ 16 ตัวอักษร เทียบแบบ timing-safe) รับ `POST /v1/generate` `{model, system, messages, maxOutputTokens?}` แล้วรัน
   `claude -p --output-format json --model <model> --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --setting-sources project [--system-prompt <system>]` โดย prompt ไปทาง **stdin** ใน **cwd เป็น temp dir ว่าง** (ลบทิ้งหลังจบ) · `--tools ""` ปิด built-in tool ทั้งหมด (อ่านจาก `claude --help`) · ไม่ใช้ shell (บน Windows resolve `claude.exe` ข้าง `claude.cmd`; ปฏิเสธ `.cmd`/`.bat`) · ตัด `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` ออกจาก env ของ child เพื่อให้ใช้ subscription ไม่ใช่ key · model ต้องตรง `^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$` (กัน flag injection) · timeout 180 s (kill child) · concurrency สูงสุด 2 (เกินตอบ 429) · body ≤ 1 MB · **ไม่ log prompt/response/stderr** log เฉพาะ status, latency, model, จำนวน token · ตอบ `{text, model, finishReason, usage{inputTokens,outputTokens}}` (cache tokens นับเป็น input)
3. **Adapter `createCliBridgeProvider`** (`packages/ai/src/providers/claude-cli.ts`, kind `claude-cli`) POST ไป `CLAUDE_CLI_BRIDGE_URL` (default `http://host.docker.internal:4317`) พร้อม token ผ่าน `fetch` ที่ inject เท่านั้น · URL ต้องเป็น `http` และ host ∈ {localhost, 127.0.0.1, [::1], host.docker.internal} · ข้อความทุกช่องเป็น `RedactedText` ตาม contract จึง redact ก่อนออกจากแพ็กเกจเสมอ (N4) · error เป็น `ProviderError` (429/5xx = retryable) ไม่ echo body · อยู่หลัง `createAuditedLlm` เหมือน provider อื่น → `ai_run`, daily cap, kill switch ทำงานเหมือนเดิม
4. **ราคา:** เจ้าของจ่ายเป็น subscription จึงตั้ง `AI_MODEL_PRICES` เป็น 0 ได้ (schema เป็น `nonnegative` อยู่แล้ว) กฎ "ทุก tier ต้องมี model และมี price entry" ยังอยู่ — `costUsd` ใน `ai_run` จะเป็น 0 (ไม่ใช่ค่าใช้จ่ายจริง) ส่วน **daily token cap ยังบังคับ** ผ่านจำนวน token ที่ CLI รายงาน · model id มาจาก `AI_MODEL_DEEP/STANDARD/LIGHT` (alias ที่ CLI รับ เช่น `opus`/`sonnet`/`haiku`) ไม่มีชื่อ model ใน code
5. **Tool call: ไม่ต้องมี native `tool_use`** — ADR-013 กำหนดให้ runbook สร้างโดยโค้ด model ไม่เลือก tool; investigator/drafter เรียก tool ฝั่ง `ToolRegistry` (read-only, allow-list, N2) แล้วส่งผลเป็นข้อความให้ model; `LlmRequest` ไม่มีฟิลด์ tools จึงไม่มีอะไรให้ CLI path "ทำไม่ได้" ปิด tool ของ CLI ทั้งหมดเพื่อไม่ให้ model ใน CLI แตะไฟล์/เครือข่ายของเครื่อง host เอง ถ้าอนาคตเพิ่ม native tool_use เข้า contract provider นี้ต้องปฏิเสธ (fail ผ่าน audited path ด้วย error ชัดเจน) ไม่ emulate แบบหลอกว่าสำเร็จ
6. **ไม่ fallback เงียบ:** ขาด token/URL/model/price → `ProviderUnavailableError` (audited เป็นแถว error) และ `readiness()` รายงานปัญหา · bridge ล่ม/ timeout → `ProviderError` retryable ไม่ตอบด้วย mock
7. **DB:** migration `0081` เพิ่ม `claude-cli` ใน `ai_run_provider_check` (embedding ยัง mock อย่างเดียว ไม่แตะ `kb_embedding_index`)
8. **Compose:** `x-app-env` ส่ง `CLAUDE_CLI_BRIDGE_URL/TOKEN`; worker มี `extra_hosts: host.docker.internal:host-gateway` (api ไม่เรียก AI จึงไม่ต้อง)

## Options considered
- **A — bridge ฝั่ง host (เลือก)** — ใช้ได้กับ worker ใน Docker โดยไม่เปลี่ยน architecture; ข้อเสีย: ต้องรัน process เพิ่มเอง
- **B — ติดตั้ง `claude` ใน image worker + mount credential** — ต้องใส่ OAuth credential ของเจ้าของใน container/volume (เสี่ยง N1) และ image ใหญ่ขึ้น
- **C — รัน worker นอก Docker** — ไม่ตรงกับวิธีรันมาตรฐานของ repo (compose)
- **D — emulate tool_use ผ่าน JSON** — ไม่จำเป็นเพราะ runbook อยู่ในโค้ด (ข้อ 5)

## Consequences
- ใช้ได้เฉพาะ dev/POC · ห้ามใช้ใน production หรือกับ instance ที่ลูกค้าเข้าถึงได้ · เงื่อนไขการใช้งาน subscription ของ Anthropic กับการใช้อัตโนมัติ `[ASK-HUMAN]` เจ้าของควรตรวจเอง
- latency สูงกว่า API (spawn ต่อ call) · concurrency 2 ทำให้ ingest จำนวนมากช้า (queue retry รับไหว)
- ตัวเลข token มาจาก JSON ของ CLI ซึ่งโครงสร้างอาจเปลี่ยนตามเวอร์ชัน `[UNVERIFIED 70%]` — parser ตรวจเข้ม ถ้าไม่ตรงจะ fail เป็น `cli_failed` ไม่เดา
- ที่ยังไม่ได้ยืนยันด้วยการรันจริง `[UNVERIFIED]`: พฤติกรรม `--tools ""`, `--setting-sources project`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` กับ CLI จริง; การที่ container เข้าถึง bridge ที่ bind `127.0.0.1` ผ่าน `host.docker.internal` บน Docker Desktop (ถ้าไม่ได้ ตั้ง `CLAUDE_CLI_BRIDGE_HOST=0.0.0.0` โดย token เป็นด่านเดียว)
- ตรวจซ้ำ: เมื่อ Claude Code เปลี่ยนรูปแบบ `--output-format json`, เมื่อ contract เพิ่ม native tool_use

## Links
- ADR-008 (AI layer), ADR-011 (policy gate), ADR-013 (runbook ที่โค้ดสร้าง), T-132 (AI_PROVIDER)
- PRD §6.1, §6.6 (N2, N4) · `claude --help` (CLI 2.1.316, ตรวจ 2026-11-02)
