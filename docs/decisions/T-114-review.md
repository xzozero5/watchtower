# T-114 — Security review: channels + AI

- **ผู้ตรวจ:** `security-reviewer` (อ่านอย่างเดียว) · **โค้ด:** `main` @ `082d41b` · **วันที่:** 2026-11-04 (เวลากรุงเทพ)
- **ผล:** ไม่มี P0/P1 · P2 × 3 (+C-1 ที่ T-170 แก้) · P3 × 8 · ตามเงื่อนไขของ ADR-022/STATUS: T-114 ผ่านเกณฑ์ "ไม่มี P0/P1" สำหรับ pilot T-115 `[REVIEWED]`

## Findings
| ID | Sev | ที่ | ปัญหา | วิธีแก้ | ติดตามใน |
|---|---|---|---|---|---|
| C-1 | P2 | `docker-compose.yml` claude-bridge `ports:` | publish `127.0.0.1:4317` ขัด ADR-019 §3 / ADR-021 §3 | ลบ port, worker ใช้ `http://claude-bridge:4317`, ตัด `host.docker.internal` จาก allow-list เมื่อเลิกใช้ | T-170 |
| C-2 | P2 | `packages/ai/src/redaction/detectors.ts` | เบอร์โทร/บัตรเครดิตที่คั่นทีละหลัก (`0 8 1 2 …`, `0.8.1…`, 16 กลุ่ม 1 หลัก) ไม่ถูก redact `[TESTED]` probe | cluster กลุ่มละ 1 หลัก ทดสอบแบบตัวเลขต่อกัน (เบอร์ 9–10, Luhn 13–19) + test | T-114a |
| C-3 | P2 | `apps/worker/src/ai/investigation.ts`, `packages/domain/src/inbound/identity.ts` | disclosure `verified` ของอีเมลเชื่อ `From` อย่างเดียว ไม่ดู SPF/DKIM/DMARC | อ่าน `Authentication-Results` ตอน ingest; ไม่ผ่าน → `restricted` + ป้าย "unauthenticated sender" | T-114a |
| C-4 | P3 | `apps/worker/src/ai/system-tool-ports.ts`, `tool-ports.ts` | data tool ของ AI ไม่ดู `dataHardening()`; ไม่ตรวจว่า `AI_READONLY_DATABASE_URL` read-only จริง | ปฏิเสธเมื่อ hardening มีปัญหา + ตรวจ role ตอน boot | T-114a |
| C-5 | P3 | `packages/shared/src/config.ts` | `GMAIL_PUSH_AUDIENCE` ซ้ำกับ `ALERT_PUSH_AUDIENCE` ได้ → token ข้าม endpoint | refine ให้ fail เมื่อเท่ากัน + `.env.example` | T-114a |
| C-6 | P3 | `packages/ai/src/audited.ts`, `agents/common.ts` | kill switch/งบบังคับต่อ agent ไม่อยู่ใน `createAuditedLlm`; งบ check-then-act | ย้าย guard เข้า `generate` (fail closed) + test สแกนทุก agent | T-114a |
| C-7 | P3 | `tools/push-only-filter/filter.mjs`, `gmail-push.service.ts` | filter ไม่ส่ง IP ต้นทาง → bucket เดียว ถูกทำให้เต็มได้ (dev/POC) | ลด per-client limit หรือส่ง `X-Forwarded-For` trust hop เดียว | T-114a |
| C-8 | P3 | `apps/api/src/line/line-webhook.service.ts` | ไม่เทียบ `destination` กับ OA (ปลอดภัยตอนนี้เพราะ OA เดียว) | เก็บ bot user id ต่อ account | T-114a |
| C-9 | P3 | `apps/worker/src/ai/people-names.ts` | ชื่อ staff, IP, passport, ที่อยู่, LINE userId ไม่ถูก redact `[TESTED]` probe | `[ASK-HUMAN]` scope ของ N4 | เจ้าของ |
| C-10 | P3 | HANDOFF, ADR-020 | GCP project id ของ instance เจ้าของอยู่ใน repo (N1 เป็นกลาง) | แทนด้วย `<project-id>` | **แก้แล้ว 2026-11-04** |
| C-11 | P3 | `packages/shared/src/config.ts`, `tools/claude-cli-bridge/server.mjs` | ADR-021 ยังไม่ implement; bridge ปฏิเสธ production เองด้วย | แก้ทั้ง config และ bridge + test | T-170 |
| C-12 | P3 | `docs/09-SECURITY.md` §8 | checklist ยัง `[OPEN]` ทั้งที่ทำแล้วหลายข้อ | main thread อัปเดต | handoff |

## ตรวจแล้วไม่พบปัญหา (สรุป)
LINE HMAC บน raw body + constant-time + dedupe · Gmail push OIDC (iss/aud/email_verified/อายุ) · Discord Ed25519 + replay window · alert HMAC แยก secret/purpose · route สาธารณะ deny-by-default · credential envelope encryption ไม่มี token plaintext · egress host คงที่/allow-list · N2 registry deny-by-default, model ไม่เลือก tool, read-only tx · N3 CHECK stage 0–2 + REVOKE UPDATE + SECURITY DEFINER + `decide()` ปฏิเสธ `ai_auto` · N4 `RedactedText` บังคับด้วยชนิด, ไม่มี `.generate` ดิบ, `ai_run` fail closed · kill switch + token cap ใช้กับ claude-cli ราคา 0 · bridge `shell:false`, `--tools ''`, ตัด env key, token timingSafeEqual · gmail-tunnel ผ่านเฉพาะ POST path เดียว

## Test ที่ผู้ตรวจรัน `[TESTED]`
`@watchtower/ai` 452 passed / 29 skipped · `@watchtower/channels` 588 passed · tools (bridge/tunnel/filter) 413 · probe redactor 2 script (อยู่นอก repo)

## ตรวจไม่ได้
`[UNVERIFIED]` CLI 2.1.316 ปิด tool จริงด้วย `--tools ''` / ไม่โหลด `~/.claude/CLAUDE.md` · `[UNVERIFIED 60%]` ระดับ DMARC ที่ Gmail บังคับ (ความเป็นไปได้ของ C-3) · undici ตัด `Authorization` เมื่อ redirect ข้าม origin · MIME header injection และ sanitize HTML ขาเข้าเชิงลึก · `pnpm audit` · build/รัน image bridge และ tunnel
