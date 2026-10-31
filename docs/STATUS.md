# STATUS — สถานะโปรเจกต์ (main thread อัปเดตทุกครั้งที่ปิด task)

รูปแบบ entry: `## YYYY-MM-DD HH:MM (Asia/Bangkok) — <ใคร/agent> — <phase/task>` แล้วตามด้วย ทำอะไร / ไฟล์ที่แตะ / test / ค้าง / ไม่ยืนยัน
snapshot สั้นสำหรับ cold start อยู่ที่ `HANDOFF.md` — ไฟล์นี้คือ log ต่อ task + open questions

## สถานะปัจจุบัน
| Phase | สถานะ (2026-10-31) | ค้าง |
|---|---|---|
| 0 Foundation | ⬜ ยังไม่เริ่ม | T-000 รอ repo |
| 1 Inbox + AI 0–2 + Shifts | ⬜ | — |
| 2 Reliability + Usage | ⬜ | — |
| 3 Autonomy + Learning | ⬜ | — |
| 4 Mobile + Scale | ⬜ | — |

- Test ล่าสุด: ยังไม่มีโค้ด
- Blockers: ไม่มี · `[ASK-HUMAN]` ค้าง: repo/license, credential, PRD §16

## Open questions / `[UNVERIFIED]` / `[ASSUMED]` ที่ยังค้าง
- PRD §16 ข้อ 1–10 (repo host, Cloud SQL replica, GCP projects, mailbox + delegation, LINE plan/volume, Discord, ทีม/กะ, SLA tiers, open-source approval, AI provider/budget)
- LINE TH pricing/quota `[VERIFY]` · LINE mark-as-read `[VERIFY]` · Google managed MCP availability `[VERIFY]`
- วันหยุดราชการไทย 2026–2027 สำหรับ business calendar `[VERIFY]` (T-008)
- งบ API: ยังไม่ตั้ง (`config/budgets.yaml` ค่า default `[ASSUMED]`)

## กติกาจากบทเรียน (เติมเมื่อเจอ)
- (ยืมจากโปรเจกต์ก่อน) ตรวจซ้ำรายงาน agent ก่อน commit · ห้าม `git stash/checkout` ขณะ agent แก้ไฟล์เดียวกัน · test ห้ามเขียนลง data จริง · ไฟล์ที่มี backslash แก้ด้วย Edit tool · ห้ามพิมพ์ secret ออก stdout แม้เพื่อตรวจ

## Log

## 2026-10-31 21:05 (Asia/Bangkok) — Claude (claude.ai planning session) — Pre-Phase 0
- ทำอะไร: research, PRD v0.1, ชุดไฟล์วิธีทำงาน (AGENTS, CLAUDE, START-HERE, BACKLOG, HANDOFF, templates, agents, commands, hooks, ADR-001, FIRST_PROMPT)
- ไฟล์ที่แตะ: ทั้งชุด kickoff
- test: —
- ค้าง: T-000
- ไม่ยืนยัน: ดูหัวข้อ Open questions
