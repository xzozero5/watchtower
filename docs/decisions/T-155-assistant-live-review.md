# Security review — Assistant live provider (`ab82dba`) + T-155 ClamAV

- **ผู้ตรวจ:** `security-reviewer` (อ่านอย่างเดียว) · **วันที่:** 2026-11-04 (เวลากรุงเทพ)
- **ผล:** ไม่มี P0/P1 · P2 × 4 (ต้องแก้ก่อนเปิด `UPLOAD_SCAN=clamav` / live assistant ใน pilot) · P3 × 6 → T-155a

| ID | Sev | ที่ | ปัญหา | วิธีแก้ |
|---|---|---|---|---|
| C-1 | P2 | `apps/api/src/portal/portal-attachments.service.ts` | quota portal ทั้ง instance → คนนอกทำให้เต็มได้ < 1 ชม. ลูกค้าทุกรายแนบไม่ได้ 24 ชม. · TOCTOU เกินเพดาน | quota ต่อ IP/email/org + global เป็น backstop, Redis INCRBY, audit/แจ้ง admin (รวม T-154) |
| C-2 | P2 | compose `clamav`, `apps/worker/src/scan/clamd.ts` | config ตั้งต้นอาจ `AlertEncrypted no`/`AlertExceedsMax no` `[ยังไม่ยืนยัน 75%]` → zip มีรหัส/เกินขนาด = clean | mount `clamd.conf` เปิด AlertEncrypted*/AlertExceedsMax + test EICAR ใน zip มีรหัส |
| C-3 | P2 | `apps/worker/src/ingest/processor.ts`, `scan/scanner.ts` | raw `.eml` ที่มีไฟล์ติดเชื้อไม่ถูกลบ/สแกน · retention ไม่ครอบ raw (PDPA) | ลบ/กักกัน raw ตอน infected, retention ครอบ `raw_object_key` |
| C-4 | P2 | `apps/api/src/ai/concurrency-limit.ts`, `assistant.service.ts` | คนเดียวยึด slot + คิวได้หมด, ไม่ส่ง abortSignal, งบเช็คก่อน call | in-flight 1 ต่อ user (429), สงวน slot ให้ summaries, ผูก abort, จองงบ atomic |
| C-5 | P3 | compose `clamav` | อยู่ network `default` — clamd 3310 ไม่มี auth (SHUTDOWN) | network `scan` เฉพาะ worker + clamav |
| C-6 | P3 | compose `clamav` | ไม่มี no-new-privileges/cap_drop/pids_limit | hardening + ยืนยัน digest |
| C-7 | P3 | `docs/09-SECURITY.md`, ADR-023, `tools/claude-cli-bridge/bridge.mjs` | ไม่บันทึก api ใน network `ai` / egress anthropic ของ api · bridge ไม่ kill child เมื่อ client ปิด | อัปเดตเอกสาร + kill child on close |
| C-8 | P3 | `apps/worker/src/scan/scanner.ts` `tidy` | ไม่ลบ bidi/format chars ในชื่อไฟล์ | `\p{Cf}` / ใช้ `sanitizeFileName` |
| C-9 | P3 | `scanner.ts` orphan sweep | race กับ transaction ที่แนบไฟล์อายุ > 24 ชม. | FOR SHARE / SKIP LOCKED |
| C-10 | P3 | `clamd.ts` | idle timeout ไม่ใช่ deadline รวม | เพิ่ม deadline รวม |

ตรวจแล้วไม่พบปัญหา: assistant ทุก call ผ่าน `createAuditedLlm` (redaction/`ai_run`/guard/งบ), ไม่ fallback mock, token bridge timingSafeEqual, api ไม่ได้ OAuth token, limiter คืน slot ถูกต้อง, bridge ปิด tool · T-155 gate fail closed ทุกทางออกที่พบ (2 download routes + mail dispatcher), LINE/Discord ไม่ส่งไฟล์, SQL ไม่มี input ผู้ใช้, INSTREAM framing ถูก, ERROR ไม่กลายเป็น clean, migration 0091 มี CHECK/down
ตรวจไม่ได้: integration tests ของสองงาน (main thread รันในเกตรวม), config จริงของ image clamav 1.5.3 `[VERIFY]`, `AI_DAILY_TOKEN_CAP` ว่าง + claude-cli ราคา 0 → cap รายวันมีผลไหม `[ยังไม่ยืนยัน]`
