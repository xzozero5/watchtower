# ADR-031 — AI bridge เลือก Claude / Codex และใช้ Codex บน instance เจ้าของ

- **Status:** Accepted
- **Date:** 2026-11-05 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของสั่งให้ทำโหมด AI bridge และเปลี่ยนไป Codex เพราะ Claude subscription หมดอายุ
- **Context:** ADR-017/019/021 ผูก bridge กับ Claude ทั้งชื่อ service, config และ audit ต้องคง redaction, audit, daily token cap, policy gate และไม่เปิด autosend (PRD §6, N1–N4)

## Decision

1. Canonical provider `ai-cli`, runner `pnpm ai-bridge`, directory `tools/ai-bridge`, service `ai-bridge`; `AI_BRIDGE_MODE=codex|claude` เลือก backend ตอนเริ่ม process (default `codex`). ไม่ fallback ข้าม vendor หรือไป mock อัตโนมัติ
2. ใช้ `AI_BRIDGE_URL/TOKEN/ALLOW_REMOTE` เป็นชื่อกลาง; canonical มี precedence เหนือ alias `CLAUDE_CLI_BRIDGE_*` / `CLAUDE_CLI_ALLOW_REMOTE`. เก็บ provider `claude-cli` และ runner เดิมเป็น compatibility path สำหรับ Claude; ตรวจ mode mismatch โดย fail closed. เก็บ audit เก่า และเพิ่ม `ai-cli` ใน DB CHECK ด้วย additive migration
3. Model มาจาก `AI_MODEL_DEEP/STANDARD/LIGHT` และ agent overrides เหมือนเดิม ไม่มีชื่อ model hardcode ในโค้ด; grader independence และ policy เดิมคงอยู่. Clone ใหม่ยัง default `AI_PROVIDER=mock`
4. Codex ใช้ `codex exec --ephemeral --json -` ผ่าน stdin, native executable, `shell:false`, cwd ชั่วคราวว่าง; ไม่โหลด user/project instructions, config, MCP, skills, hooks หรือ plugins. ปิด built-in tools, web และ delegation โดย config ของ CLI ที่ตรวจแล้ว; sandbox read-only เป็น defense เพิ่ม ไม่ถือว่าเท่ากับปิด tools. ห้ามใช้ bypass sandbox. ต้องพิสูจน์ tool isolation ด้วย synthetic prompt ก่อนเปิด traffic จริง; ถ้าพิสูจน์ไม่ได้ให้ fail closed และบันทึก blocker
5. Child env จำกัด runtime/auth ที่จำเป็น ไม่ส่ง DB/integration secret หรือ bridge token; ใช้ subscription login ที่มีบน host โดยไม่อ่าน/พิมพ์/คัดลอก credential. Host runner เหมาะกับ Windows login เดิม; container mode ต้องมี login ของ instance แยก ห้าม mount ทั้ง Codex home
6. Codex parser รับเฉพาะ assistant final และ completed usage ที่สมบูรณ์; reject malformed/failed/incomplete/tool events. Cached input เป็นส่วนหนึ่งของ input tokens ห้ามนับซ้ำ. คง bearer token, timeout, disconnect cancellation, concurrency, body/output cap, no prompt/response/stderr logs; online check ตาม vendor
7. Owner อนุญาตเปลี่ยน instance ไป Codex ในคำขอนี้; deploy แบบย้อนกลับได้โดย config โดยไม่เปลี่ยน schema production อัตโนมัติ. จัดทำ migration/runner พร้อมก่อนใช้ `ai-cli` กับ DB ที่ยังไม่ migrate. ไม่เปิด `AI_AUTOSEND_ENABLED`

## Options considered

- **AI bridge + explicit backend (เลือก):** ใช้ pipeline/audit เดิมและสลับ vendor ได้ชัดเจน
- **เปลี่ยน binary ใน claude-cli เฉย ๆ:** ปฏิเสธ เพราะ audit/config แสดงชื่อ vendor ผิด และ CLI output/tools ไม่เหมือนกัน
- **OpenAI API key:** ไม่ตรงคำขอใช้ Codex subscription ปัจจุบัน

## Consequences

- Login และโควตา Codex ต้องพร้อมบนเครื่องที่รัน bridge; ไม่สัญญาว่า subscription ไม่มี limit
- Token usage จาก CLI ใช้ daily cap; ราคา subscription ที่ตั้ง 0 ไม่ใช่ค่าใช้จ่ายจริง
- CLI isolation และ event schema ผูกกับเวอร์ชันที่ตรวจ ต้องตรวจใหม่เมื่ออัปเกรด
- [TESTED 2026-11-05] exact CLI `0.166.0-alpha.5.1` ทั้ง Windows และ Linux container ส่ง outbound `tools=[]` ผ่าน mock endpoint ที่มีเฉพาะ dummy auth. Static catalog ปิด `apply_patch_tool_type` และ tool surfaces; ไม่ใช้ `web_search_tool_type=null` เพราะ schema ไม่รับ null
- [TESTED 2026-11-05] host subscription login เรียก synthetic pong ได้ทั้ง 3 tiers; API runtime จริงผ่าน redaction/guard/audit โดยไม่มี customer data. POC API/worker healthy หลัง backup และ migration 0112–0116
- [CONFIRMED] canonical runtime config ถูก append เป็น non-secret overrides ใน env เดิมภายนอก repo โดยไม่เปิดอ่าน/พิมพ์ secret; ปิด bridge container เดิม ใช้ host runner แทน
- [UNVERIFIED] container subscription login จริงและการทำงานหลัง host reboot; ไม่ย้าย credential จาก host เข้า container
- [UNVERIFIED] Codex JSONL ไม่มี actual response model field ในผลที่ทดสอบ; adapter คืน requested model id จึงไม่ใช่หลักฐานการ resolve alias สำหรับ independence gate. คง autosend ปิดและทบทวนก่อน stage 3

## Links

- Official OpenAI documentation ตรวจ 2026-11-05: https://learn.chatgpt.com/docs/non-interactive-mode
- Config / feature controls: https://learn.chatgpt.com/docs/config-file/config-reference
- ADR-017, ADR-019, ADR-021, ADR-025
