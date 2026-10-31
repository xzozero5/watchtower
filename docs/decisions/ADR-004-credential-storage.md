# ADR-004 — ที่เก็บ secret และการตั้ง credential ของ integration ผ่าน UI

- **Status:** Accepted (เจ้าของเคาะ 2026-10-31) `[CONFIRMED]`
- **Date:** 2026-10-31 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของโปรเจกต์
- **Context:** N1 เดิมเขียนว่า secret อยู่ใน environment เท่านั้น แต่ PRD §4.12, §6.7, §8.1 และ `channel_account.config_encrypted` ใน §7 ให้ตั้ง credential ของ integration จากหน้า admin แบบเข้ารหัส · องค์กรที่ fork ไปใช้ต้องตั้งค่าและหมุน key ได้โดยไม่ต้อง deploy ใหม่

## Decision
| ประเภท | ที่เก็บ | ตัวอย่าง |
|---|---|---|
| Bootstrap / infra | environment หรือ Secret Manager เท่านั้น | `DATABASE_URL`, `REDIS_URL`, `S3_*`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, รหัส break-glass admin |
| Integration | environment หรือ DB แบบเข้ารหัส ตั้งผ่านหน้า admin | LINE, Discord, Gmail, GitHub App, API key ของ AI provider |

กฎของการตั้งผ่าน UI:
- **สิทธิ์:** `head` เท่านั้น (PRD §2.2)
- **อ่านกลับไม่ได้:** API และหน้าจอรับค่าได้อย่างเดียว แสดงแค่สถานะ "ตั้งแล้ว" กับวันที่อัปเดต
- **การเข้ารหัส:** envelope encryption ด้วย `APP_ENCRYPTION_KEY` หรือ KMS บน GCP (PRD §6.7)
- **Audit:** บันทึกว่าใครเปลี่ยนอะไรเมื่อไร ไม่เก็บค่า และค่าต้องไม่ลง log
- **ปุ่มทดสอบ:** ตรวจการเชื่อมต่อก่อนบันทึก (PRD §4.12)
- **ลำดับความสำคัญ:** ถ้าตั้งใน environment ไว้ ค่านั้นชนะ และ UI แสดงว่าถูกล็อกจาก environment

## Options considered
- **Environment อย่างเดียว** — เรียบง่าย ไม่มี secret ใน DB แต่ต้อง deploy ใหม่ทุกครั้งที่หมุน key และขัดกับ PRD
- **DB อย่างเดียว** — ตั้งค่าง่าย แต่ทีมที่ใช้ Secret Manager ควบคุมเองไม่ได้ และยังต้องมีกุญแจเข้ารหัสใน environment อยู่ดี
- **แยกตามประเภท (เลือก)** — ตรงกับ PRD และรองรับทั้งสองแบบ แลกกับการต้องดูแล credential store และ flow หมุนกุญแจ

## Consequences
- N1 และ `.claude/agents/integration-engineer.md` แก้ตาม ADR นี้แล้ว
- Phase 1 ต้องมี credential store + หน้า admin ก่อนต่อ integration จริง (T-116) · ทุก adapter อ่านผ่าน store นี้ ไม่อ่าน `process.env` เอง
- DB backup มี credential ที่เข้ารหัสอยู่ จึงต้องเก็บ `APP_ENCRYPTION_KEY` แยกจาก backup และต้องมีวิธีหมุนกุญแจ
- `security-reviewer` ตรวจตอน T-114

## Links
- PRD §2.2, §4.12, §6.7, §7, §8.1, §8.2 · ADR-001 · AGENTS.md N1
