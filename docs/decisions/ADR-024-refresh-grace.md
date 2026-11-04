# ADR-024 — Grace window ของ refresh-token rotation (แก้ข้อ "ไม่มี grace window" ของ ADR-005)

- **Status:** Proposed (ยังไม่มีโค้ดตาม ADR นี้ · รอเจ้าของ/`architect` + `security-reviewer` ตัดสิน)
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของโปรเจกต์ (เพราะเปลี่ยน trade-off ด้าน security ของ ADR-005 ที่ Accepted แล้ว)
- **Context:**
  - ADR-005: refresh token ใช้ได้ครั้งเดียว ใช้ซ้ำ = revoke ทั้ง session (`refresh_reuse`) และ "ไม่มี grace window: browser ต้อง refresh ทีละ tab (single-flight)" · โค้ด `apps/api/src/auth/session.service.ts` `refresh()` ทำตามนี้ (ล็อกแถว token แล้วถ้า `used_at` ไม่ว่าง = reuse)
  - QA-31 (T-149): single-flight ฝั่ง web (`apps/web/src/lib/api/refresh-coordinator.ts`) กันได้เฉพาะภายใน tab/โปรเซสเดียว ส่วน **หลาย tab, service worker, หรือ request ที่หลุดกลางทาง (response ของ refresh หายเพราะเครือข่ายล่ม แต่ server หมุน token ไปแล้ว)** ทำให้ client ถือ token เก่าที่ใช้แล้ว → ถูกตีความว่า replay → ผู้ใช้ถูกออกจากระบบทั้งเส้นโดยไม่มีผู้โจมตี `[ASSUMED]` ว่าเกิดได้จริงบนเครือข่ายมือถือ/PWA (ยังไม่ได้วัดความถี่ — `[UNVERIFIED 60%]`)
  - ฝั่งตรงข้าม: ถ้าเปิด grace โดยไม่ระวัง ผู้โจมตีที่ขโมย token ได้ใช้ในช่อง grace แล้วได้ session คู่ขนาน และ reuse detection อ่อนลง
  - ข้อกำหนดที่ต้องไม่เสีย: ISO 27001 session control, PRD §8.2, N4 (audit ครบ), ไม่มี token ใน JSON body (ADR-005)

## Decision (ร่าง — ข้อเสนอ ยังไม่ใช่มติ)
เสนอ **Option B**: grace window แคบ ผูกกับ token ตัวถัดไปที่ออกไปแล้ว ไม่ใช่ "token เก่าใช้ได้อีก"

1. **ไม่เก็บ token ตัวใหม่ไว้ตอบซ้ำ** (เก็บแต่ hash ตาม ADR-005) ดังนั้น server ส่ง token ตัวเดิมกลับไปอีกครั้งไม่ได้ ต้องออกตัวใหม่
2. จึงเสนอแบบ **idempotent re-issue ภายในช่อง `REFRESH_GRACE_SECONDS` (ค่าเริ่มต้นเสนอ 10 วินาที, 0 = ปิด = พฤติกรรมปัจจุบัน)**: ถ้า token ที่ใช้แล้ว (`used_at` ไม่ว่าง) มาภายใน grace **และ** token ตัวที่มันถูกแทน (`replaced_by`) **ยังไม่เคยถูกใช้** **และ** `ip` + `user_agent` ตรงกับตอนหมุนครั้งแรก → ออก token ตัวที่สาม (ห่วงโซ่ยาวขึ้น) และ **revoke token ตัวที่สอง** (ที่ยังไม่ถูกใช้) ทันที เพื่อให้มี token ที่ใช้ได้เพียงตัวเดียวเสมอ · นอกเงื่อนไขนี้ = reuse เหมือนเดิม (revoke ทั้ง session)
3. ทุกครั้งที่เข้าทางนี้ลง audit `auth.refresh.grace` (session id, อายุ token เก่า, ผลการเทียบ ip/ua) — ไม่เงียบ · เพดาน: ต่อ session ใช้ grace ได้ไม่เกิน N=3 ครั้งต่อชั่วโมง เกินแล้วถือเป็น reuse
4. ฝั่ง web ยังต้อง single-flight ต่อไป (grace เป็นตาข่ายรอง ไม่ใช่ทางหลัก) และ `BroadcastChannel`/`navigator.locks` ข้าม tab เป็นงานแยกของ `frontend-dev`

## Options considered
- **A — คงเดิม (ไม่มี grace)**: ปลอดภัยที่สุด เรียบง่ายที่สุด · ผู้ใช้จริงถูกเตะออกเมื่อ response หาย/หลาย tab ชนกัน (QA-31) · แก้ได้บางส่วนด้วย `navigator.locks` ฝั่ง web โดยไม่แตะ server
- **B — grace แคบ + re-issue ผูกเงื่อนไข ip/ua + revoke ตัวที่สอง (ข้อเสนอ)**: ลดการเตะออกโดยไม่จำเป็น · ผู้โจมตีที่ขโมย token และมี ip/ua เดียวกับเหยื่อในช่อง 10 วิยังได้ session ได้ (ความเสี่ยงตกค้างต่ำ แต่ไม่ใช่ศูนย์) · ซับซ้อนกว่า ต้อง migration ถ้าต้องเก็บสถานะเพิ่ม (ข้อเสนอนี้ใช้ `replaced_by`, `used_at` เดิม ไม่ต้อง migration แต่ต้องเก็บ ip/ua ต่อ token — **ต้องเพิ่มคอลัมน์ 2 ตัวใน `refresh_tokens`** จึงต้อง migration ที่ย้อนกลับได้)
- **C — grace แบบ "ตอบ token ตัวใหม่ซ้ำ" (เก็บ token sealed ไว้ชั่วคราว)**: UX ดีที่สุด (client ได้ token ตัวเดิมที่ server ออกไปแล้ว) · ต้องเก็บ token แบบถอดรหัสได้ในฐานข้อมูล ผิดหลักการ "เก็บเฉพาะ hash" ของ ADR-005 → **ไม่แนะนำ**

## Consequences
- ถ้ารับ B: ต้องแก้ ADR-005 บรรทัด "ไม่มี grace window" (เขียนว่าถูกแทนด้วย ADR-024), เพิ่ม env `REFRESH_GRACE_SECONDS` (`.env.example`, validate ด้วย Zod, ค่า 0 ปิด), migration เพิ่ม `ip`/`user_agent` ใน `refresh_tokens` (+ `.down.sql`), integration test: (1) response หายแล้ว retry ภายใน grace ได้ session ต่อ (2) เกิน grace = revoke (3) ip/ua ไม่ตรง = revoke (4) ตัวที่สองถูกใช้ไปแล้วแล้วตัวแรกมาซ้ำ = revoke (5) เกินเพดาน N ครั้ง = revoke (6) audit ทุกครั้ง · `security-reviewer` ตรวจก่อนปิด
- ต้องวัดจริงก่อนตัดสิน: นับ `refresh_reuse` ที่เกิดจากผู้ใช้จริงใน pilot (T-115) ว่าความถี่เท่าไร ถ้าแทบไม่เกิดหลังเพิ่ม `navigator.locks` ฝั่ง web ให้เลือก A
- **ไม่มีการแก้โค้ดตาม ADR นี้จนกว่า Status เป็น Accepted**

## Links
- ADR-005 (`docs/decisions/ADR-005-auth-session-audit.md` — "Refresh token ... ไม่มี grace window")
- `apps/api/src/auth/session.service.ts` `refresh()`, `apps/web/src/lib/api/refresh-coordinator.ts`
- BACKLOG T-149 (QA-31), T-125
