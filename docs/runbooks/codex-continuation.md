# Codex continuation

ADR-032 / T-437. Automation `watchtower-checkpoint` เรียกแชตนี้ทุกชั่วโมงเมื่อ Codex app และเครื่องพร้อมใช้งาน ไม่เพิ่มโควตาหรือรับประกันเวลาเริ่มหลัง reset

## แต่ละรอบ
1. อ่าน AGENTS/HANDOFF และ `node tools/codex-continuation/cli.mjs status` แล้วตรวจ usage ด้วย `get_usage_limits` ก่อนงานหนัก
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
