---
description: Phase 1 — Inbox (Gmail/LINE/portal) + AI stage 0–2 + KB + CSAT + Discord + Shifts/Handoff
---
เริ่ม Phase 1 ตาม `docs/BACKLOG.md` (T-101..T-115) — ก่อนเริ่มให้ `po` + `architect` แตก task ให้ละเอียดกว่านี้ถ้ายังหยาบ แล้ว main thread บันทึกลง BACKLOG
ลำดับแนะนำ: T-101 UI spec → ∥ T-102 Gmail, T-103 LINE, T-104 Discord (integration-engineer ทีละตัว หรือ 2 session ขนานถ้าไม่แตะไฟล์เดียวกัน) · ∥ T-106 AI core + T-107 KB (ai-engineer / backend-dev) → T-108 investigator/drafter (mock tools) → T-109 AI sidebar → T-105 notifications → T-110 CSAT → T-111 shifts → T-112 autonomy model → T-113 QA (AC-2/4/7, §5.1–5.2) → T-114 security → T-115 po review + `[ASK-HUMAN]` ก่อนต่อ credential จริงและ pilot
ทุก adapter ต้องมี mock mode รัน e2e ได้โดยไม่มี credential · PII redaction ต้องมีก่อน LLM call แรก (N4) · ทุก intent เริ่มที่ stage 2 (N3)
ปิดด้วย `/review` + `/handoff`
