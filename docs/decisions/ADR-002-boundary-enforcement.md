# ADR-002 — กลไกบังคับ boundary และ dependency matrix

- **Status:** Accepted
- **Date:** 2026-10-31 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread (ไม่เบี่ยง stack ของ ADR-001)
- **Context:** T-001 ต้องบังคับ boundary ด้วย lint (N10) · `import-x/no-restricted-paths` resolve ผ่าน symlink ใน `node_modules` จึงปฏิเสธ `packages/channels` → `@watchtower/shared` ที่อนุญาตอยู่ `[TESTED]`

## Decision

- ตาราง `WORKSPACES` ใน `tools/eslint/boundaries.mjs` เป็นแหล่งเดียวของ dependency matrix
- ชื่อ package: `@typescript-eslint/no-restricted-imports` + `no-restricted-syntax`
- path: local rule `watchtower/no-relative-escape` ห้าม path ออกนอก workspace
- กฎเพิ่มจาก BACKLOG `[ASSUMED]`: `apps/web` ห้ามใช้ `db`, `ai`, `channels` · `shared` เป็น leaf · `ai` กับ `channels` ไม่ขึ้นต่อกัน · นับ Redis/BullMQ เป็นกลุ่มเดียวกับ DB · ห้าม `fetch` ใน `ai`
- ตรึง TypeScript `~6.0` จนกว่า `typescript-eslint` จะรองรับ 7
- Mailpit เป็น service สำหรับ local/dev ใน compose เท่านั้น (เติมจาก service list ของ ADR-001)
- `config/models.yaml` ใช้กับ AI ที่ build โปรเจกต์เท่านั้น โค้ดแอปอ่าน provider/model จาก DB ตาม PRD §6.7 (ชี้แจงถ้อยคำใน ADR-001 แถว AI)

## Options considered

- **`import-x/no-restricted-paths`** — มาตรฐาน แต่ปฏิเสธ dependency ที่อนุญาต ต้องมี native resolver และ target ต้องมีไฟล์จริง
- **`no-restricted-imports` อย่างเดียว** — ไม่มี dep เพิ่ม แต่แยก path ข้าม workspace จาก path ภายในไม่ได้ เช่น `../../api` กับ `./api`
- **Local rule + `no-restricted-imports` (เลือก)** — แม่นยำ ไม่มี dep เพิ่ม ตรวจได้แม้ยังไม่มีไฟล์ แลกกับโค้ด rule ราว 50 บรรทัดที่ต้องดูแล

## Consequences

- workspace ใหม่ต้องเพิ่มในตาราง ไม่งั้น test fail
- ข้ามได้ด้วย `eslint-disable` และ `import(variable)` ต้องจับตอน review
- ตรวจ TypeScript 7 ซ้ำเมื่อ `typescript-eslint` ขยาย peer

## Links

- PRD §12 · BACKLOG T-001 · `docs/04-ARCHITECTURE.md` §3 · npm registry (ตรวจ 2026-10-31)
