# T-449 — merge main และ deploy local (2026-11-11)

## ขอบเขตที่เจ้าของอนุมัติ
ผู้ใช้อนุมัติ merge codex/workflow-recovery เข้า main และ deploy local ต่อจาก T-448 โดยไม่ส่งข้อความจริง คง autosend/person narration ปิดและ embedding mock/AI bridge Codex เดิม

## Source / artifact
- [TESTED] main fast-forward 89483da2 → fb3e1a29 และ push origin/main สำเร็จ; source branch CI42923812114 ผ่านก่อน merge
- Runtime diff อยู่เฉพาะ web; ไม่มี API/worker/schema/shared/UI changes จึง build/recreate เฉพาะ web ไม่ migrate DB หรือ restart dependencies
- [TESTED] สร้าง build context ด้วย git archive fb3e1a29 ไม่มี .agents/.codex/.cache; ไม่ส่ง owner directories เข้า Docker
- ข้อจำกัดที่พบ: .dockerignore เดิมไม่ exclude โฟลเดอร์เหล่านี้ การใช้ tracked snapshot แก้สำหรับ deploy นี้เท่านั้น ยังไม่ใช่การแก้ ignore ถาวร
- [TESTED] Docker build exit0; image sha256:7c11a23d9dbc26a9218105966c3fcb7c36479f0f3fea68280d7fa3e0e8f30cff; BUILD_ID VHR-QKl9sBCLUBQ4DW0Op

## Backup / rollback
- [TESTED] tools/restore-drill/backup.sh ใช้ pg_dump custom และ pg_restore -l ตรวจอ่านได้ 243 tables with data /13,862,043bytes: D:/Works/watchtower-backups/watchtower-20261111-024454-pre-t449-deploy.dump (นอก repo ไม่พิมพ์ข้อมูล)
- ไม่ได้ซ้อม restore รอบนี้ และ backup ไม่รวม MinIO attachments; งานนี้ไม่แก้ schema/data
- image เดิมเก็บเป็น watchtower/web:rollback-t449 (sha256:37543299796a4f677133a4557f981b367c2f05b0609d21dcf53e97e48697c962)
- ถ้า rollback ให้ tag rollback image กลับ watchtower/web:local แล้ว compose up --no-deps --no-build --wait web ด้วย envfile เดิม ไม่แตะ volumes

## การตรวจจริง
- [TESTED] exact new image รันชั่วคราวบน3339/API mock4999: composer-pending E2E staff/Gmail/portal × delayed success/failure 6/6ผ่าน (14.9s), retries0; imageIDตรง POC ที่ deploy ไม่ login/ส่งข้อความในข้อมูลจริง
- [TESTED] compose --env-file ภายนอก -p watchtower up --no-deps --no-build --wait web exit0 และ healthy; ไม่มีใช้ --remove-orphans หรือ down/volume deletion
- [TESTED] HTTP web3000/health, API4000/health/ready, worker4100/health/ready, proxy8080/health =200; POC9containers healthy; smoke container ของงานถูกลบแล้ว
- [TESTED] API container1d129dabc601/imageb7495087 และ workerbd097337aa94/imaged896dae6 คงเดิม; web API_URL/APP_URL/PORT/NODE_ENV เดิมตรวจเป็นbooleansทั้งหมด true (ไม่เปลี่ยน development runtime config ในงานนี้)
- [TESTED] API/worker autosendOff/personNarrationOff/embeddingMock/aiCli booleans true ทั้งก่อน/หลัง ไม่มีการพิมพ์ secret/env dump

## Host AI bridge
- [TESTED] ตรวจพบ host4317 offline ตั้งแต่ก่อน swapเว็บ จึงเปิด runnerเดิม tools/ai-bridge/start-host.ps1 กับ envfileเดิมและ pinned-runtime.env overlay modecodex/loopback PID5228
- Immediateprobe connrefused ระหว่าง startup; หลัง startup host4317/healthz และ API→host.docker.internal4317/healthz=200
- ไม่เปลี่ยนprovider/CLIversion/credentials ไม่เรียก generation หรือส่ง customer content; healthผ่านไม่ใช่การทดสอบคำตอบ LLM จริง

## Independent review / CI
- ผู้ตรวจ /root/deploy_review คนละตัวกับผู้ deploy พบ build-context risk ก่อนbuild และตรวจ snapshot/flags/container baseline แยกแล้ว postdeploy PASS: exactimage/4HTTP200/APIworkerIDs/flags/webconfig/bridgehostและAPIworker200/online/9healthy ไม่มีP0/P1/P2ค้างสำหรับdeploymentนี้
- [TESTED] CI main42948052133 ที่ fb3e1a29 completed/successครบ4jobs (Docker,static/unit,integration,E2E); local build และ exact-artifact browser smoke ผ่านแล้ว
- Evidence local ignored: deploy449-build.log, deploy449-browser.log, deploy449-ci-watch.log; compose up log อยู่ D:/Works/watchtower/deploy449-up.log
