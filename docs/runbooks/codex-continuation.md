# Codex continuation

ADR-032 / T-437. Automation `watchtower-checkpoint` เรียกแชตนี้ทุกชั่วโมงเมื่อ Codex app และเครื่องพร้อมใช้งาน ไม่เพิ่มโควตาหรือรับประกันเวลาเริ่มหลัง reset

## แต่ละรอบ
1. อ่าน AGENTS/HANDOFF แล้วตรวจ usage ด้วย `node tools/codex-continuation/quota-cli.mjs check` ก่อนงานหนัก (account quota จริง ไม่ใช่ context window); ตรวจ checkpoint ผ่าน `sync` ที่ไม่พิมพ์ claim token
2. ถ้า window ใดเหลือ ≤5% ให้ pause. ใช้ reset จริงเฉพาะ window ที่หมด/ใกล้หมด; window ที่ยังใช้ได้ให้ใส่เวลา UTC ปัจจุบัน มิฉะนั้นจะรอ weekly reset โดยไม่จำเป็น. เมื่อเวลาไม่ทราบให้ blocked และไม่เดา
3. ก่อนเริ่มใช้ checkpoint running พร้อม owner PID ที่อยู่ตลอดงาน; เก็บ claim-token ไว้ local ห้ามเขียนใน tracked doc. การแก้ checkpoint ของ owner ต้องมี token เดิม. CLI process สั้นห้ามใช้ PID ตัวเองเป็น runner ระยะยาว. สถานะ running ที่ owner ยังมีชีวิตห้าม claim running ซ้ำแม้มี token; เก็บ progress ใน HANDOFF/STATUS และใช้ claim เดิมจน release/pause/complete. บันทึก output claim ลง cache เฉพาะเมื่อ command exit 0 ไม่ใช้ pipeline ที่ truncate token file ก่อนคำสั่งสำเร็จ
4. ทำ bounded task ทีละชิ้น, dev 1 + reviewer 1 สูงสุด แล้ว main ตรวจไฟล์/test; อัปเดต HANDOFF/STATUS/BACKLOG/log พร้อม commit. เมื่อยังมี quota และงานอิสระให้ **ทำชิ้นถัดไปทันทีใน turn เดิม** ไม่จบรอบเพื่อรอ heartbeat. checkpoint เป็นขอบเขตกู้สถานะ ไม่ใช่เพดานงานต่อรอบ. Remote push ล้มให้บันทึกแล้วเดินงาน local ที่ไม่ขึ้นต่อกันต่อ. lock ไม่ครอบคลุม agent ที่ไม่ใช้ checkpoint จึงต้องตรวจ process/worktree ก่อนเริ่มเสมอ
5. จบงานที่อนุมัติทั้งหมดและ verify deploy/push แล้วจึง complete และปิด heartbeat

## คำสั่ง
`node tools/codex-continuation/cli.mjs checkpoint --task T-437 --state ready`

`node tools/codex-continuation/cli.mjs pause --five-hour-reset <UTC-ISO> --weekly-reset <UTC-ISO>`

ไม่มี loop เรียก AI, ไม่มี auth scraping, ไม่ซื้อเครดิต และไม่เปลี่ยนบัญชี. สถานะเก็บใน Git info directory ไม่ commit; ห้ามใส่ customer data/secret ใน checkpoint. หาก process ถูกหยุดกะทันหัน ให้ตรวจ Git กับ HANDOFF ก่อน reclaim

## อำนาจตัดสินใจ
เจ้าของมอบ PO ตัดสินใจ scope/default/ลำดับงาน 2026-11-06 และอนุมัติ deploy/push/stop container ที่ไม่ใช้แล้ว. คง LINE ภายหลัง, autosend ปิด. หากต้อง credential ใหม่หรือเปิด autosend ให้บันทึก blocked ชัดเจนและทำงานอิสระอื่นต่อ

## 2026-11-11 — quota guard ที่อ่านได้จริง (T-448)
- ใช้ `node tools/codex-continuation/quota-cli.mjs check` ก่อนงานหนักและทุก safe boundary แทน `get_usage_limits` ที่ session นี้ไม่มี อ่าน `account/rateLimits/read` ผ่าน signed-in `codex app-server --stdio` โดยไม่อ่าน auth file/เรียก LLM และไม่พิมพ์ account/claim token
- `sync --task T-448 --owner-pid <long-lived PID>` รับ fresh observation แล้ว claim งาน; stdout มี `admitted` ต้องเป็น true ก่อนเริ่มงาน ไม่ใช้ CLI process สั้นเป็น owner เมื่อมี live claim เดิม caller ต้องมี PID และ `WT_CONTINUATION_CLAIM_TOKEN` ตรงกัน token อ่านจาก checkpoint เฉพาะใน process และไม่เขียน tracked file
- ข้อมูล quota เกิน 60 วินาที/ขาด/ผิดรูปแบบ = blocked; remaining ≤5% ของ applicable window ใด = waiting_limit; window null คือ server ยืนยันว่าไม่มี window นั้น ไม่ใช่ context window; reset timestamp อย่างเดียวไม่อนุญาต resume ต้องอ่าน quota สดและผ่าน gate เดิมด้วย
- ก่อนพักให้เขียน HANDOFF/STATUS/daily log พร้อมคำสั่งและผลทดสอบที่ค้าง หยุด agent/runner ที่ยังทำงานตามความเหมาะสมแล้ว release claim โดยไม่ทิ้งการเปลี่ยนแปลง
- Heartbeat `watchtower-quota-checkpoint` ผูกแชต `01a1c6a0-3f88-7fa3-b8e4-671094178bb0` ทุกชั่วโมง แจ้งเฉพาะ failure; ไม่สร้าง daemon/ซื้อเครดิต/เปลี่ยนบัญชี เมื่อทำงานอนุมัติครบให้ complete และ pause heartbeat
- Guard ทำงานที่ safe boundary ไม่รับประกันหยุดกลาง model turn ที่กำลังใช้ quota; scheduler ต้องเปิดเครื่องและแอป และเมื่อ quota หมดจนเริ่ม turn ไม่ได้อาจปลุกล่าช้า การทดสอบ synthetic reset/resume ไม่ใช่หลักฐานว่ารอ reset บัญชีจริงแล้ว
- checkpoint เดิมใน Git common info ใช้ร่วมทุก worktree ก่อนเริ่ม task ใหม่ต้องตรวจ HANDOFF ว่างานเดิมปิดแล้ว เก็บ snapshot เดิมและ complete ก่อนเปลี่ยน task ห้ามทับงาน active ของคนอื่น
- แหล่งทางการที่เปิดอ่าน 2026-11-11: https://learn.chatgpt.com/docs/app-server (`account/rateLimits/read`, `usedPercent`, `windowDurationMins`, `resetsAt`)
