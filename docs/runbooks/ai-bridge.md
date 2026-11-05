# AI bridge — Codex / Claude

อ้างอิง ADR-031 · เจ้าของสั่ง 2026-11-05 ให้ใช้ Codex เพราะ Claude subscription หมดอายุ

## Config

| ตัวแปร | ความหมาย |
| --- | --- |
| `AI_PROVIDER=ai-cli` | provider กลางใน API/worker และ audit |
| `AI_BRIDGE_MODE=codex` หรือ `claude` | backend ของ process bridge; default Codex |
| `AI_BRIDGE_URL` | host runner: `http://host.docker.internal:4317`; container: `http://ai-bridge:4317` |
| `AI_BRIDGE_TOKEN` | secret ≥ 16 ตัวอักษร ตั้งนอก repo ให้ตรงกันระหว่าง bridge/API/worker |
| `AI_BRIDGE_ALLOW_REMOTE=true` | opt-in เมื่อ app เป็น production หรือ URL ไม่ใช่ loopback |
| `AI_MODEL_DEEP/STANDARD/LIGHT` | model ที่ backend รับได้ ต้องมีราคาใน `AI_MODEL_PRICES` ครบ |

Canonical config ที่ตั้งไว้ชนะ legacy `CLAUDE_CLI_BRIDGE_*`/`CLAUDE_CLI_ALLOW_REMOTE`; ค่าว่างใช้ legacy ได้. `AI_PROVIDER=claude-cli` คงใช้กับ Claude เท่านั้นและปฏิเสธ mode mismatch. ไม่ fallback ข้าม vendor. เปลี่ยน mode ต้อง restart process; model override ราย agent ต้องเปลี่ยนด้วย โดยเฉพาะ grader ต้องคนละ model กับ drafter ตาม ADR-025

## Host runner (Windows login เดิม)

1. ติดตั้ง Codex CLI ที่เวอร์ชันผ่าน isolation check แล้ว และ login ด้วย `codex login` บนเครื่องเจ้าของ; ห้ามเปิดอ่าน/คัดลอก credential
2. ตั้ง config ข้างต้นใน env ภายนอก repo หรือ config overlay ที่ไม่มี secret. ตรวจ `AI_AUTOSEND_ENABLED` ยังปิด
3. เริ่มด้วย `node --env-file=<external-env-path> tools/ai-bridge/server.mjs`; `pnpm ai-bridge` ใช้ `.env` ถ้ามี. ใช้ `tools/ai-bridge/start-host.ps1` เมื่อต้องเปิดค้างแบบไม่มีหน้าต่าง
4. Host default bind loopback. Docker Desktop ใช้ `host.docker.internal`; ถ้าต้อง bind กว้างกว่าให้จำกัด firewall ตามเครื่องจริงและคง bearer token ทุก generation request
5. ทดสอบ `/healthz` และ generation ด้วย synthetic prompt ก่อนเปิดงาน; ห้าม log body/stderr. ตรวจ output/backend/token usage และ no tool events
6. API/worker ต้องใช้ image ที่รองรับ `ai-cli` และ migration `0116` แล้ว. ทำ backup ก่อน migrate POC; production schema ต้องเจ้าของอนุมัติเฉพาะครั้ง

## Container mode

`docker compose --env-file <path> --profile ai up -d --build ai-bridge` ใช้ dedicated volume `codexstate` ไม่ mount Codex home ของคน. Login ภายใน instance ด้วย `docker compose --env-file <path> exec ai-bridge codex login --device-auth` โดยเจ้าของดำเนินการเอง. Container ไม่ publish port และไม่เห็น DB/integration secret. Codex binary/version ที่ไม่ผ่าน isolation จะไม่รับงานจริง

Docker build context เดิม `tools/claude-cli-bridge` เลิกใช้แล้ว ให้ใช้ `tools/ai-bridge` ทั้งสอง mode; legacy `pnpm claude-bridge` ยังรองรับบน host

ก่อนรับงาน Codex ต้องมี `models_cache.json` ของ CLI ใน dedicated Codex home ด้วย (host เดิมมีแล้ว). Instance ใหม่ต้องให้เจ้าของเปิด CLI เพื่อโหลด model catalog หลัง login ก่อน; bridge อ่านเฉพาะ metadata นี้ ไม่อ่านหรือคัดลอก auth. Catalog/model ที่ขาดจะ fail closed. เวอร์ชันที่ตรวจแล้วคือ `0.166.0-alpha.5.1` ทั้ง Windows host และ Linux container (synthetic outbound request ไม่มี tools); เวอร์ชันอื่น startup ปฏิเสธจนตรวจใหม่

## สลับกลับ Claude

ตั้ง `AI_BRIDGE_MODE=claude`, model tiers/overrides และราคาที่ Claude รองรับ แล้ว restart bridge/API/worker. ใช้ canonical provider `ai-cli` ต่อได้. การสลับ backend ไม่เปลี่ยน autonomy stage, daily caps, audit หรือ redaction. หากใช้ legacy `pnpm claude-bridge` runner จะเลือก Claude เสมอ

## ข้อจำกัด

- โควตา/login subscription ขึ้นกับบัญชี; ราคา 0 ใน audit ไม่ใช่ค่าใช้จ่ายจริงของ subscription
- Codex ไม่มี native per-call token cap ใน invocation นี้; จำกัด byte/time และใช้ actual CLI usage บังคับ daily token cap
- CLI update ต้องตรวจ isolation/schema ใหม่ ไม่ fallback เป็น invocation ที่เปิด tools มากขึ้น
- Host runner ต้องเปิดอยู่จึงเรียก AI ได้; หลัง reboot ให้เริ่ม runner ใหม่หรือจัดการ startup ตามนโยบายเครื่อง

## CLI ของแอปอัปเดต แต่ bridge ต้องใช้เวอร์ชันที่ผ่าน isolation

[TESTED 2026-11-06] global CLI alpha.6 ถูก bridge ปฏิเสธตามที่ออกแบบ. ติดตั้ง CLI alpha.5.1 แยกด้วย `npm install --prefix .cache/ai-bridge-cli --no-audit --no-fund @openai/codex@0.166.0-alpha.5.1` ไม่ downgrade CLI ของเจ้าของ. ตั้ง `CODEX_CLI_BIN` เป็น path absolute ของ native codex.exe ภายใต้ cache นี้ใน local overlay (ไม่มี credential) แล้วเริ่ม start-host.ps1 พร้อม `-OverlayFile logs/ai-bridge/pinned-runtime.env`. ไม่ใช้ cmd shim; ห้ามเลิกตรวจเวอร์ชันเพื่อแก้ startup. Cache/overlay ไม่เข้า Git. เครื่องใหม่ต้องสร้าง overlay ใหม่และ login ตามเดิม.
