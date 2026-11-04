# T-306a — Security review Phase 3 (stage 3, procedures, grader/golden, reports, T-152, Web Push, NER)

- **ผู้ตรวจ:** `security-reviewer` (อ่านอย่างเดียว + ยิง SQL โจมตีใน container ทิ้ง) · **วันที่:** 2026-11-05 (เวลากรุงเทพ)
- **ผล:** ไม่มี P0 (flag ปิด + ไม่มี intent stage 3 = ส่ง ai_auto ไม่ได้) · **P1 × 1** ต้องแก้ก่อนเปิด `AI_AUTOSEND_ENABLED` ที่ใด · P2 × 7 · P3 × 6 · **ADR-025 ยังไม่ Accepted จนปิด C-1…C-4** → T-306e/T-306f
- ชั้น L0 (flag), L2 (DB trigger/DEFINER), L3 (owner approve) ทนทุก bypass ที่ยิงจริง `[TESTED]`

| ID | Sev | ที่ | ปัญหา | วิธีแก้ |
|---|---|---|---|---|
| C-1 | **P1** | `packages/domain/src/autonomy/autosend-facts.ts` | step `require_human` ของ procedure ไม่ถูก gate อ่าน (`ticketRequiresHuman()` ไม่มีผู้เรียก) · escalation card ค้างไม่บล็อก | fact `procedure.requireHuman`/`escalationPending` → deny `procedure_requires_human` + property/integration test (+ DB trigger) |
| C-2 | P2 | `autosend-text.ts` | `linksAllowed` ปล่อยเบอร์โทร, @handle, IP, `evil[.]com`, fullwidth, IDN `[TESTED]` · `customerWantsHuman` พลาดหลายวลี TH/EN | deny contact/host ที่ normalize แล้วถ้าไม่อยู่ใน snippet KB ที่ cite · หลังมี ai_auto ให้ inbound ถัดไป = ขอคน |
| C-3 | P2 | `autosend-facts.ts`, `autosend-text.ts` | portal ใช้ `contact.verifiedAt` — ใครก็ยื่นด้วยอีเมลของ contact verified ได้ (ขัด ADR-007 C-4) | portal verified เฉพาะ `requesterVerified=true` |
| C-4 | P2 | `watch.ts`, `gate-report.ts`, `decide.ts` | (ก) เปลี่ยน model/prompt/procedure โดยไม่มี replay ผ่านยังไม่ระงับ (ข) eval/redaction eval ไม่ร่วมตัดสิน report (ค) ไม่มี grade `sampled` | fact `replayPassedForCurrent`, report อ่านผล eval (ไม่มี = insufficient_data), sampled grade หลังส่ง |
| C-5 | P2 | `apps/api/src/auth/google-oidc.service.ts`, `autonomy.service.ts` | re-auth = session ใหม่ ≤ 5 นาที แต่ OIDC `prompt=select_account` ไม่มี `max_age`/`auth_time` | owner approve: `prompt=login` + `max_age=300` + ตรวจ `auth_time`, audit auth method |
| C-6 | P2 | `0096` | app role INSERT gate report `green` ที่ metrics ว่างได้, blocker ไม่ตรวจ `window_start >= intent.created_at` `[TESTED]` | REVOKE INSERT จาก app → DEFINER/role worker, เช็ก created_at + metrics, UI owner แสดงตัวเลขดิบ |
| C-7 | P2 | `procedure-simulate.ts`, `shared/src/procedure.ts` | simulation รันที่ stage ≤ 2 เสมอ step `stages:[3]` ไม่เคยถูก simulate | simulate ทั้ง 2 และ 3 หรือ validation ห้าม stages ที่ทำให้ 3 ต่างจาก 2 |
| C-8 | P2 | `packages/domain/src/ai/golden.ts`, `apps/api/src/ai/golden.service.ts` | golden ข้าม org ต่อ intent redact แค่ PII — ชื่อ org/เลขสัญญา/ยอดเงินหลุดไป drafter ของ org อื่น | จำกัด org เดียวกัน หรือ redact identifier ของ org + lead ยืนยันตอน mark |
| C-9 | P3 | `0096`, `0097` | app INSERT `ai_grade` model/score เองได้ (ไม่ผูก ai_run), INSERT simulation passed แล้ว publish autosend allowed ได้, `apply_stage_promotion` ไม่ตรวจสิทธิ์ actor `[TESTED]` | trigger อ่าน model จาก ai_run, publish/apply ตรวจ `user_holds_permission`, guard ตรวจ text = draft + footer |
| C-10 | P3 | `autosend-facts.ts` | inbound `ORDER BY asc LIMIT 200` → ticket ยาวไม่อ่านข้อความล่าสุด | desc หรือ aggregate ใน SQL |
| C-11 | P3 | `apps/worker/src/ai/autosend.ts` | ไม่มี ai_run → fallback model จาก settings · independence เทียบ alias `[UNVERIFIED 50%]` | ไม่มี run = deny · บันทึก model id จริง |
| C-12 | P3 | `portal-my-requests.service.ts` | `mine-global` นับก่อนตรวจ contact → DoS เพดานรวม | นับ global หลังพบ contact |
| C-13 | P3 | `weekly-brief.service.ts` | publish รับ recipients อิสระนอกองค์กร | จำกัด staff active / domain allow-list |
| C-14 | P3 | `gate-report.ts` | กลุ่ม AI ขึ้นกับ disposition ที่คนกด → ปั่นตัวเลขได้ | แสดงสัดส่วน disposition ต่อคนใน report |

ตรวจแล้วไม่พบปัญหา (ย่อ): ให้สิทธิ์ owner_approve ตัวเอง/UPDATE stage ตรง/`set_intent_autonomy(3)`/INSERT seed_batch/TEMP table + pg_temp ถูกปฏิเสธทั้งหมด `[TESTED]` · flag อ่านครั้งเดียว + worker ตรวจซ้ำ · message body แก้ไม่ได้, hash ตรวจสองชั้น · retry ai_auto ถูก deny · grader redact + Zod + violation cap · procedure tool ∩ granted · CEO export กัน formula/HTML injection · weekly brief email ไม่มีข้อความ restore · T-152 token 256 bit sha256 single-use 202 เท่ากัน · Web Push allow-list + DNS pinning + sw.js same-origin · NER fail closed · replay เขียน `evals/.replay/` (gitignored)
ตรวจไม่ได้: ความทนของ grader ต่อ injection กับ model จริง `[ASK-HUMAN]` key · integration worker/api ของงานเหล่านี้ (main thread รันในเกต) · email แจ้งคำตอบใหม่ของ portal ใส่เนื้อคำตอบหรือไม่ (ผลต่อ C-3)
