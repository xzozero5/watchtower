# ADR-020 — container `gmail-tunnel`: quick tunnel ที่ subscribe Pub/Sub เองตอนขึ้น (dev/POC)

- **Status:** Accepted (เฉพาะ dev/POC บนเครื่องเจ้าของ)
- **Date:** 2026-11-03 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของโปรเจกต์ (สั่ง "ทำ container ที่เปิด cloudflare tunnel แล้วไป subscribe topic นั้นตอน run" และเลือก quick tunnel URL สุ่ม)
- **Context:** การทดสอบรับ-ส่ง Gmail จริง (T-171: composer ใหม่, Bcc) ต้องให้ Pub/Sub push ถึง api จาก internet · ขั้นตอนเดิม (runbook §4) ต้องเปิด `push-filter` + `cloudflared` ในเครื่อง แล้วแก้ endpoint และ audience ใน GCP console กับ env ของ api ทุกครั้ง เพราะ URL ของ quick tunnel สุ่มใหม่ทุกครั้ง

## Decision
1. **compose service `gmail-tunnel`** (profile `gmail-tunnel`, `restart: unless-stopped`, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, ไม่ publish port) image จาก `tools/gmail-tunnel/Dockerfile`: `node:22-bookworm-slim` + binary `cloudflared` คัดจาก image ทางการ `cloudflare/cloudflared:2026.10.2` ที่ตรึงด้วย digest
2. ใน container รัน 2 process: (ก) `tools/push-only-filter` บน `127.0.0.1:4318` ส่งต่อ**เฉพาะ** `POST /v1/inbound/gmail/push` ไป `http://api:4000` (filter ยอม upstream เป็น loopback หรือ `api` เท่านั้น) (ข) `cloudflared tunnel --url http://127.0.0.1:4318` (quick tunnel ไม่ใช้บัญชี/credential ของ Cloudflare)
3. อ่าน URL `https://<คำ-คำ>.trycloudflare.com` จาก log ของ cloudflared (ไม่นับ `api.trycloudflare.com`) → รอ log `Registered tunnel connection` (ต่อ edge แล้ว — ไม่ลองเรียก URL ตัวเอง เพราะ DNS ของเครื่อง/hotspot อาจยังไม่รู้จักชื่อใหม่หรือ cache ว่าไม่มี ขณะที่ resolver ของ Google รู้แล้ว `[TESTED 2026-11-03]`) → ขอ access token ด้วย JWT bearer ของ service account ผู้ดูแล subscription (key JSON mount read-only, ส่ง assertion ได้เฉพาะ `oauth2.googleapis.com`) → `subscriptions.modifyPushConfig` ตั้ง `pushEndpoint=<URL>/v1/inbound/gmail/push` + `oidcToken{serviceAccountEmail=GMAIL_PUSH_SERVICE_ACCOUNT, audience=GMAIL_PUSH_AUDIENCE}` → self-check (POST ด้วย token ปลอม) ต้องได้ 401 จาก api — ลองซ้ำได้ 3 นาที และไม่ทำให้ container ล่ม
4. **audience คงที่:** `GMAIL_PUSH_AUDIENCE` เป็นข้อความคงที่ (ไม่จำเป็นต้องเป็น URL — Pub/Sub ใช้ endpoint เป็น audience เฉพาะเมื่อไม่ได้ตั้ง) api จึงตรวจค่าเดิมได้ตลอดและ**ไม่ต้อง restart** เมื่อ URL เปลี่ยน · api ไม่ถูกแก้
5. process ลูกตัวใดตาย → container exit → compose restart → URL ใหม่ + subscribe ใหม่ · healthcheck ผ่านเฉพาะเมื่อ subscribe สำเร็จ · log มีแค่ URL, ชื่อ subscription, HTTP status — ไม่มี token, key, body
6. สิทธิ์ขั้นต่ำ: SA แยก (`watchtower-pubsub-admin`) ที่มี `Pub/Sub Editor` บน subscription เดียว + `Service Account User` บน SA ผู้ลงนาม push · ไม่ใช้ key ของ Gmail

## Options considered
- **A — quick tunnel + subscribe เอง (เลือก)** — ไม่ต้องมีโดเมน/บัญชี Cloudflare; ข้อเสีย: URL สุ่ม, ต้องมี SA ที่แก้ subscription ได้, ช่วงที่ container ปิด subscription ชี้ URL ตาย (Pub/Sub retry ตาม retention, worker sync เก็บตก)
- **B — named tunnel + โดเมนตัวเอง** — URL คงที่ ตั้ง Pub/Sub ครั้งเดียว ไม่ต้องมี SA ที่แก้ subscription; ข้อเสีย: ต้องมีโดเมนบน Cloudflare + credential ของ tunnel (เจ้าของเลือก A)
- **C — ทำมือแบบเดิม** — ยังใช้ได้ (runbook §4 ท้าย) แต่ช้าและพลาดง่าย

## Consequences
- dependency ใหม่ที่มี network: `cloudflared` (ออกไป Cloudflare edge) และ container เรียก `oauth2.googleapis.com` / `pubsub.googleapis.com` — เจ้าของสั่งเองในข้อความ 2026-11-03 · ปลายทาง ingress สาธารณะเปิดเฉพาะเมื่อเจ้าของรัน profile นี้ และผ่าน filter path เดียว
- ใช้ได้เฉพาะ dev/POC; production ใช้ ingress จริง (ADR-014) ไม่ใช่ quick tunnel
- **รันจริง 2026-11-03 `[TESTED]`:** custom role `watchtowerPushEndpointUpdater` + SA `watchtower-pubsub-admin` (binding บน `gmail-push-sub` + actAs `watchtower-pubsub-push`) ใน `<project-id>` → container subscribe สำเร็จ, self-check ผ่าน tunnel ถึง api ได้ 401 · image ต้องมี CA bundle (คัดจาก image cloudflared) ไม่งั้น cloudflared ล้มด้วย x509 · `[UNVERIFIED]` push ของอีเมลจริง + audience ที่ไม่ใช่ URL ฝั่ง Google (รอส่งอีเมลทดสอบ)
- ตรวจซ้ำ: เมื่อ bump `cloudflared` (รูปแบบ log ของ URL), เมื่อ Pub/Sub API เปลี่ยน

## Links
- runbook `docs/runbooks/local-poc.md` §4 · ADR-014 (GCP deployment) · T-171 · `tools/gmail-tunnel/*`, `tools/push-only-filter/server.mjs`, `docker-compose.yml` service `gmail-tunnel`
- Pub/Sub REST `projects.subscriptions.modifyPushConfig`, Google OAuth 2.0 JWT bearer flow (อ้างจากความรู้ ณ 2026-11-03 ยังไม่ได้เปิดเอกสารซ้ำ → `[VERIFY]`)
