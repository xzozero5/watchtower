# Runbook — ติดตั้ง staging บน GCP (T-118, ADR-014)

> **สถานะ: ยังไม่เคยรันจริง** เขียนจากการอ่านโค้ดและความจำของ GCP; ทุกข้อที่ติด `[VERIFY]` ต้องตรวจกับเอกสารทางการปัจจุบันตอนลงมือ · **ผู้รัน = คน (เจ้าของหรือ ops ที่เจ้าของมอบหมาย)** — agent ห้ามรัน `gcloud` / `terraform init|plan|apply` (`[ASK-HUMAN]`: credential จริง + ค่าใช้จ่าย + `init` โหลด registry)
> placeholder ในคำสั่ง: `<PROJECT_ID>`, `<REGION>`, `<DOMAIN>` (= `base_domain` เช่น `staging.example.com`) — ไม่ใส่ค่าจริงของใครใน repo (N1) · ห้ามพิมพ์ค่า secret ลง terminal/log/แชต

## 0. ภาพรวมและเวลา

```
ลูกค้า/พนักงาน ──https──▶ Load Balancer (app.<DOMAIN>, api.<DOMAIN>) ──▶ Cloud Run web / api
Gmail ─▶ Pub/Sub ─push(OIDC)─▶ https://api.<DOMAIN>/v1/inbound/gmail/push
LINE  ─────────webhook────────▶ https://api.<DOMAIN>/v1/inbound/line/{channelAccountId}
worker (Cloud Run, always-on) ─▶ Cloud SQL / Memorystore (private) ─▶ Cloud NAT (IP คงที่) ─▶ SMTP relay, LINE, Discord, AI
```

ใช้เวลาโดยประมาณ 0.5–1 วันทำงานรอบแรก `[ASSUMED]` (ส่วนที่รอ: DNS + managed certificate, allow-list IP ที่ SMTP relay, Workspace admin อนุมัติ delegation)

## 1. ต้องมีก่อนเริ่ม (`[ASK-HUMAN]` ทุกข้อ)

- [ ] GCP **project ใหม่สำหรับ staging** + billing account + **budget alert** (ตั้งก่อน apply; ดูค่าประมาณใน ADR-014 Consequences `[ASSUMED]`)
- [ ] ผู้รันมีสิทธิ์เทียบเท่า Owner ใน project นี้ (ระหว่างติดตั้ง) และสิทธิ์ใน Workspace admin ถ้าจะทำ Gmail delegation
- [ ] โดเมนที่เจ้าของคุมได้ + สิทธิ์สร้าง DNS record 2 ชื่อ: `app.<DOMAIN>`, `api.<DOMAIN>`
- [ ] region (ค่าเริ่มต้น `asia-southeast1` `[ASSUMED]`)
- [ ] Organization Policy ไม่ห้าม `allUsers` invoker บน Cloud Run (`iam.allowedPolicyMemberDomains`) และไม่ห้าม public IP ของ LB; ถ้าห้าม ต้องขอยกเว้นเฉพาะ project นี้
- [ ] SMTP relay: host/port (465 หรือ 587), มี credential + TLS หรือไม่ (ถ้าไม่มี credential ต้องบันทึกการยอมรับ `SMTP_ALLOW_INSECURE=true` ตาม ADR-014 §2), ใครเป็นคน allow-list IP
- [ ] ตัดสินใจเรื่อง Redis in-transit TLS ก่อนขึ้น production (ไม่ต้องสำหรับ staging)

## 2. Bootstrap (ทำมือครั้งเดียว)

```bash
gcloud config set project <PROJECT_ID>
# bucket เก็บ Terraform state: เปิด versioning + uniform access + ห้าม public; อยู่นอก root module นี้
gcloud storage buckets create gs://<PROJECT_ID>-tfstate --location=<REGION> --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```

Terraform เปิด API ที่ต้องใช้เองใน `network.tf` (`google_project_service`) แต่ `serviceusage` และ `cloudresourcemanager` ต้องเปิดมือก่อนถ้า project เพิ่งสร้าง `[VERIFY]`

## 3. สร้างโครงด้วย Terraform (คนรันเท่านั้น)

```bash
cd infra/terraform
cp terraform.tfvars.example staging.tfvars     # git-ignored; แก้ project_id, base_domain, image_registry_path, smtp_relay_host
terraform init -backend-config="bucket=<PROJECT_ID>-tfstate" -backend-config="prefix=watchtower/staging"
terraform fmt -recursive && terraform validate
terraform plan -var-file=staging.tfvars -out=staging.plan     # อ่านทุกบรรทัดกับเจ้าของ: skeleton นี้ไม่เคยถูกตรวจ
terraform apply staging.plan
```

- **รอบแรกคาดว่า `validate`/`plan` จะเจอ argument ผิดชื่อ** (skeleton เขียนโดยไม่ได้รัน) แก้ใน PR แยก (`infra:`) แล้วรายงาน ไม่ใช่แก้ใน tfstate
- ที่อาจเสียตั้งแต่รอบแรก: Cloud Run service ต้องมี image อยู่แล้ว — ถ้า image ยังไม่ถูก push ให้ทำข้อ 6 ก่อน `apply` ส่วนที่เป็น `google_cloud_run_v2_service` (หรือใช้ `-target` เฉพาะ network/sql/redis/storage/secrets/artifact registry ก่อน) · secret ที่ service อ้างต้องมี version อย่างน้อย 1 อัน (ข้อ 5)
- ลำดับที่แนะนำ: `-target` = `google_project_service.enabled`, `google_artifact_registry_repository.images`, network, `data.tf`, secret containers → ทำข้อ 5–6 → `apply` เต็ม
- เก็บ output: `terraform output` (ไม่มี secret) — โดยเฉพาะ `load_balancer_ip`, `egress_ip`, `cloud_sql_private_ip`, `redis_host`

## 4. DNS และใบรับรอง TLS

1. สร้าง A record: `app.<DOMAIN>` และ `api.<DOMAIN>` → `load_balancer_ip`
2. รอ managed certificate เป็น `ACTIVE` (ปกติ 15–60 นาที, นานสุดหลายชั่วโมง `[VERIFY]`): `gcloud compute ssl-certificates describe <name> --global --format='value(managed.status)'`
3. ระหว่างรอ ส่ง `egress_ip` ให้เจ้าของ SMTP relay เพื่อ allow-list (ทุก traffic ของ worker ออกที่ IP นี้; IP นี้เป็น static reserved address จึงไม่เปลี่ยนเมื่อสร้าง NAT ใหม่)

## 5. Secret และ credential ที่สร้างด้วยมือ (ไม่ผ่าน Terraform/state)

หลักการ: สร้างค่าแบบสุ่มในตัวแปร shell แล้วส่งเข้า `gcloud secrets versions add ... --data-file=-` ทาง stdin; **ห้าม echo/print**, `unset` ตัวแปรหลังใช้, ห้ามใส่ลง history (ใช้ `set +o history` หรือ prefix ช่องว่างตาม shell) · ชื่อ secret = `wt-staging-<ชื่อ env เป็นตัวเล็ก ใช้ -แทน _>` (เช่น `wt-staging-jwt-secret`; `terraform output secret_ids` แสดงชื่อจริง)

1. **รหัสผ่าน schema owner ของ Cloud SQL** — สร้าง user `watchtower_owner` ด้วย `gcloud sql users create watchtower_owner --instance=<cloud_sql_instance> --password=...` (ใช้รหัสสุ่ม URL-safe: ตัวอักษรและตัวเลขเท่านั้น, ยาว ≥ 32) แล้วเก็บ:
   - `MIGRATION_DATABASE_URL` = `postgres://watchtower_owner:<owner-pw>@<cloud_sql_private_ip>:5432/watchtower?sslmode=require`
2. **role ของแอป** — สร้างรหัสสุ่มใหม่ (URL-safe) เก็บเป็น `APP_DB_PASSWORD` และ `DATABASE_URL` = `postgres://watchtower_api:<app-pw>@<cloud_sql_private_ip>:5432/watchtower?sslmode=require` (role `watchtower_api` ถูกสร้างโดย migrate job ในข้อ 7)
   - `[VERIFY]` `pg` เวอร์ชันที่ใช้ตีความ `sslmode=require` เหมือน `verify-full` หรือไม่ ซึ่งจะล้มเพราะ certificate ของ Cloud SQL ไม่ตรงกับ IP — ถ้าล้ม ให้ลอง `?sslmode=require&uselibpqcompat=true` หรือเปิดเฉพาะ CA ของ instance; บันทึกผลใน STATUS
3. **`REDIS_URL`** = `redis://:<AUTH>@<redis_host>:<redis_port>` โดย `<AUTH>` มาจาก `gcloud redis instances get-auth-string wt-staging-redis --region=<REGION>` (ส่งต่อเข้า secret ทาง pipe ไม่ให้เห็นบนจอ)
4. **กุญแจแอป** (สุ่มด้วย crypto, ไม่ reuse ข้าม environment): `JWT_SECRET` (≥ 32 ตัวอักษร), `APP_ENCRYPTION_KEY` (32 ไบต์ base64), `PORTAL_TOKEN_SECRET` (≥ 32) · `APP_ENCRYPTION_KEY` หายไม่ได้: ข้อมูลที่เข้ารหัสไว้ (credential store ADR-012, outbox) อ่านไม่ออก → สำรองตามนโยบาย key ของเจ้าของ
5. **GCS HMAC key** — สร้างให้ service account `storage_service_account` (output ของ Terraform): `gcloud storage hmac create <storage_service_account>` แล้วเก็บ access id → `S3_ACCESS_KEY`, secret → `S3_SECRET_KEY` โดยไม่แสดงบนจอ · อายุยาว จึงหมุนเมื่อคนที่เคยเห็นออกจากทีม และอย่างน้อยทุก 90 วัน `[ASSUMED]`
6. **Integration** (ทำทีหลังตามข้อ 8, แล้วค่อยเติมชื่อใน `enabled_optional_secrets` และ `apply` ใหม่): `GOOGLE_OIDC_CLIENT_SECRET`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_LOGIN_CHANNEL_SECRET`, `SMTP_USER`, `SMTP_PASSWORD`, `DISCORD_*`, `ANTHROPIC_API_KEY`, `BREAK_GLASS_PASSWORD`, และไฟล์ `GMAIL_SERVICE_ACCOUNT_JSON` (`--data-file=<path>`; อ่านจากไฟล์ที่เก็บนอก repo แล้วลบไฟล์ต้นทางที่ไม่จำเป็น)
   - ทางเลือกตาม ADR-012: ใส่ credential ของ LINE/Gmail/Discord ผ่านหน้า admin (เข้ารหัสใน DB) แทน env ได้ ในกรณีนั้นไม่ต้องสร้าง secret เหล่านี้

## 6. Build และ push image

image เดียวกับ compose (`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`)

```bash
gcloud auth configure-docker <REGION>-docker.pkg.dev
TAG=$(git rev-parse --short HEAD)
for app in api worker web; do
  docker build -f apps/$app/Dockerfile -t <REGION>-docker.pkg.dev/<PROJECT_ID>/watchtower/$app:$TAG .
  docker push <REGION>-docker.pkg.dev/<PROJECT_ID>/watchtower/$app:$TAG
done
```

ตั้ง `image_tag = "<TAG>"` ใน tfvars (ใช้ digest `@sha256:...` ที่ production) · CI อัตโนมัติ = งานต่อไป ยังไม่มี

## 7. Migration และ deploy

```bash
terraform apply -var-file=staging.tfvars                       # เมื่อ image และ secret พร้อม
gcloud run jobs execute wt-staging-migrate --region=<REGION> --wait   # สร้าง/ปรับ schema + role watchtower_api
```

- ลำดับทุกครั้งที่ปล่อยรุ่นใหม่: push image → `migrate` job สำเร็จ → deploy revision ใหม่ของ api/worker/web (migration ต้องย้อนกลับได้และ compatible กับ revision เก่า เพราะ rolling มี 2 revision ซ้อนกัน)
- ตรวจ: `gcloud run services list --region=<REGION>` ทั้ง 3 service `Ready`; log ไม่มี `ConfigError` (ชื่อตัวแปรที่ขาด — ไม่มีค่า)
- ครั้งแรกให้ seed ข้อมูลอ้างอิงเท่านั้น (`--allow-production` ใส่ได้เฉพาะข้อมูลอ้างอิง ตาม T-121c) และสร้าง admin คนแรกตามขั้นตอนใน `docs/09-SECURITY.md` / break-glass (ADR-005); **ห้ามเปิด `DEV_LOGIN_ENABLED`** (โค้ดปฏิเสธการ boot ใน production อยู่แล้ว)

## 8. URL ที่ต้องกรอกในระบบภายนอก (คู่มือ credential อ้างอิงตารางนี้)

แทน `<API>` = `https://api.<DOMAIN>` และ `<APP>` = `https://app.<DOMAIN>` (ค่าเดียวกับ `API_URL` / `APP_URL` และ output `api_url` / `app_url`)

| ระบบ | ช่อง | ค่า |
|---|---|---|
| Google Cloud Console → OAuth client (Web) | Authorized redirect URI | `<API>/v1/auth/google/callback` |
| Google OAuth consent screen | Authorized domain | `<DOMAIN>` ระดับบนสุดที่เจ้าของครอบครอง · User type = Internal ถ้าเป็น Workspace `[ASSUMED]` |
| LINE Developers → LINE Login channel | Callback URL | `<API>/v1/line/login/callback` |
| LINE Developers → Messaging API channel | Webhook URL | `<API>/v1/inbound/line/{channelAccountId}` — สร้าง channel account ในระบบก่อน (`POST /v1/admin/channel-accounts` ด้วย `{type:"line", name}` หรือ CLI `channel-accounts`) ผลตอบกลับมี `webhookUrl` พร้อมใช้ คัดลอกไปวาง แล้วกด Verify |
| Pub/Sub subscription (Gmail) | Push endpoint | `<API>/v1/inbound/gmail/push` |
| Pub/Sub subscription (Gmail) | OIDC audience | `<API>/v1/inbound/gmail/push` (ต้องเท่ากับ `GMAIL_PUSH_AUDIENCE` ทุกตัวอักษร) |
| Pub/Sub subscription (Gmail) | Service account | output `gmail_push_service_account` (= `GMAIL_PUSH_SERVICE_ACCOUNT`) |
| Pub/Sub topic (Gmail) | Publisher | `gmail-api-push@system.gserviceaccount.com` (Terraform ใส่ให้เมื่อ `enable_gmail_push = true`) |
| Workspace Admin → Security → API controls → Domain-wide delegation | Client ID + scopes | client id ของ service account (key ใน `GMAIL_SERVICE_ACCOUNT_JSON`); scope ตามโค้ด `apps/worker/src/gmail/service-account.ts` (`gmail.readonly`, `gmail.send`) `[VERIFY ก่อนกรอก]` |
| SMTP relay (ของเจ้าของ) | IP ต้นทางที่ allow-list | output `egress_ip` (คนเดียวที่ออกผ่าน IP นี้คือ worker; เรียก LINE/Discord/AI ก็ออกที่นี่ด้วย) |
| Discord | Inbound URL | **ไม่มีใน Phase 1** (webhook ขาออก + bot token); ถ้าเพิ่ม interactions endpoint ภายหลัง ต้องเพิ่มแถวนี้และทบทวน ADR-014 |
| เนื้อหาในอีเมลที่ระบบส่ง | magic link / portal / CSAT | `<APP>/login/magic?...`, `<APP>/portal`, `<APP>/portal/tickets/{key}`, `<APP>/csat` — ไม่ต้องกรอกที่ไหน แต่ต้องเปิดจากอินเทอร์เน็ตได้ |

**ลำดับเปิด Gmail push:** (1) service account + delegation + `GMAIL_SERVICE_ACCOUNT_JSON` + `gmail_service_account_mounted = true` และ `GMAIL_IMPERSONATE_USER` ใน `extra_env` → (2) `enable_gmail_push = true` + `apply` (สร้าง topic, subscription, `PUBSUB_*`, `GMAIL_PUSH_*`) → (3) สร้าง channel account ประเภท gmail → worker เรียก `users.watch` → (4) ทดสอบส่งเมลเข้ากล่อง · `[VERIFY]` Pub/Sub อาจกำหนดให้ยืนยันความเป็นเจ้าของโดเมนของ push endpoint ที่ไม่ใช่ `*.run.app` — ถ้า `apply` ล้มด้วยข้อความนี้ ให้ verify `<DOMAIN>` ใน Google Search Console

## 9. Smoke test (ทำทีละข้อ บันทึกผลลง `docs/STATUS.md` โดย main thread)

| # | ตรวจ | คำสั่ง / วิธี | ผ่านเมื่อ |
|---|---|---|---|
| 1 | web/api เปิดได้ผ่าน HTTPS | `curl -fsS https://api.<DOMAIN>/health/ready` และ `https://app.<DOMAIN>/health` | 200 และ body ไม่มี secret |
| 2 | worker health บน `$PORT` | `gcloud run services describe wt-staging-worker --region=<REGION>` สถานะ Ready · ดู log ว่าไม่มี error ของ health server และ `PORT` ที่ Cloud Run ตั้ง (4100 ตาม `container_port`) ตรงกับ port ที่ worker เปิด | revision Ready ไม่ restart วน |
| 3 | `/metrics` ไม่หลุด | `curl -s -o /dev/null -w '%{http_code}' https://api.<DOMAIN>/metrics` | 404 |
| 4 | `/docs` ปิด | `curl -s -o /dev/null -w '%{http_code}' https://api.<DOMAIN>/docs` | 404 |
| 5 | **จำนวน proxy hop (`TRUST_PROXY_HOPS`)** | ทำการกระทำที่ลง `audit_log` 1 ครั้ง (เช่น ล็อกอินสำเร็จ) จากเครื่องที่รู้ IP สาธารณะ แล้วดูคอลัมน์ `ip` ของแถวนั้น · ลองส่ง `X-Forwarded-For` ปลอมมาด้วยอีกครั้งเพื่อดูว่าไม่ถูกเชื่อ | IP ตรงกับเครื่องที่ยิง — ถ้าเห็น IP ของ Google ให้ลดค่า, ถ้าเห็นค่าที่ client ปลอมใน `X-Forwarded-For` ได้ให้เพิ่ม; **ห้ามเปิด webhook สาธารณะก่อนผ่านข้อนี้** (`[UNVERIFIED 60%]` ว่าค่าที่ถูกคือ 2) |
| 6 | cookie ข้ามชื่อ host | ล็อกอินด้วย Google จาก `<APP>` | ได้ session; cookie `__Host-` ถูก set ที่ `api.<DOMAIN>`; `GET /v1/auth/session` จาก web ผ่าน |
| 7 | WebSocket ผ่าน LB | เปิดหน้า inbox ค้างไว้ > 1 นาที; ตัดแล้ว reconnect ได้ | event realtime มา; ไม่หลุดทุก 30 s |
| 8 | GCS ผ่าน S3 interop | แนบไฟล์ใน portal ทดสอบ หรือรัน ingest ที่เขียน raw ลง object store แล้วอ่านกลับ | PUT/GET สำเร็จ; ถ้า `SignatureDoesNotMatch` ลอง `S3_REGION` อื่นผ่าน `extra_env` (`us-east-1`) แล้วบันทึกค่าที่ได้ผล `[VERIFY]` |
| 9 | egress IP | จาก worker ส่งอีเมลทดสอบผ่าน relay (ใช้ tool/สคริปต์ที่ owner อนุมัติ) ดู header `Received` / log ของ relay | ต้นทางคือ `egress_ip` |
| 10 | pgvector | `select extension from pg_extension where extname='vector'` ผ่าน Cloud SQL Auth Proxy หรือ migrate job log | มี extension |
| 11 | worker 2 instance ซ้อน | deploy revision ใหม่ของ worker ขณะมีงานใน outbox | ไม่มี `outbound_delivery` ซ้ำ (at-most-once) ไม่มี job ค้างเกิน TTL |
| 12 | LINE webhook | กด Verify ใน LINE console หลังกรอก URL | 200 · ส่งข้อความทดสอบแล้วเกิด `inbound_event` |
| 13 | Gmail push | ส่งเมลเข้ากล่องทดสอบ | log api: push ผ่าน (204), เกิด ticket/inbound_message ภายในเป้า (AC-2 วัดใน T-113) |

## 10. การหมุน secret และ deploy ซ้ำ

- เพิ่มค่าใหม่: `gcloud secrets versions add <secret> --data-file=-` แล้ว **deploy revision ใหม่** (`gcloud run services update <svc> --region=<REGION> --update-labels=rotated=<วันที่>`) เพราะ `latest` ถูกอ่านตอน instance เริ่มเท่านั้น · `APP_ENCRYPTION_KEY` หมุนตามขั้นตอน `credentials rotate` ของ ADR-012 ไม่ใช่แค่เปลี่ยนค่า (ต้องตั้ง `APP_ENCRYPTION_KEY_PREVIOUS*` ชั่วคราว)
- ปิด version เก่า: `gcloud secrets versions disable ...` หลังยืนยันว่าไม่มี revision ใดอ้างถึง
- เมื่อเปลี่ยน `enabled_optional_secrets` / `extra_env` ให้ `terraform plan` ดูก่อนเสมอ

## 11. Rollback

- แอป: `gcloud run services update-traffic <svc> --region=<REGION> --to-revisions=<revision เดิม>=100` (web/api); worker: deploy revision เดิมซ้ำ (min=max=1)
- schema: migration ทุกตัวย้อนกลับได้ (`packages/db` `down`) แต่ **อย่าย้อน** ถ้ามีข้อมูลที่ revision ใหม่เขียนไปแล้ว; Cloud SQL มี PITR (restore เป็น instance ใหม่แล้วสลับ `DATABASE_URL`) — ซ้อมก่อน production
- Gmail/LINE: ปิดรับด้วย channel account `enabled=false` (ไม่ลบข้อมูล) ก่อน rollback ที่กระทบ schema ของ inbound

## 12. ปิด/ลบ staging

1. หยุดรับ: ปิด channel account ทั้งหมด, ลบ webhook URL ใน LINE console, หยุด `users.watch` ของกล่องเมล (โค้ดมี `users.stop` ใน `apps/worker/src/gmail/`; ยังไม่ได้ยืนยันว่าเรียกอัตโนมัติเมื่อ disable `[VERIFY]` — ถ้าไม่แน่ใจให้ลบ subscription และ topic)
2. `deletion_protection = false` ใน tfvars → `terraform apply` → `terraform destroy` (bucket ไม่ว่างจะลบไม่ได้ตามที่ตั้งใจ — ตรวจเนื้อหา/ส่งออกตาม PDPA ก่อนล้างด้วยมือ)
3. ลบ HMAC key, ลบ secret ที่ไม่ใช้, ลบ A record, แจ้งเจ้าของ SMTP relay ให้เอา IP ออก
4. ลบ project เมื่อแน่ใจ (ย้อนกลับไม่ได้ `[ASK-HUMAN]`)

## 13. ค้างอยู่ / ยังไม่ยืนยัน

- ชื่อ argument ของ Terraform provider, Direct VPC egress ใน region, ขนาด subnet ขั้นต่ำ, `ssl_mode` ของ Cloud SQL — ยังไม่เคย `init`/`validate` `[ASK-HUMAN]` เพื่อรันครั้งแรก
- ราคา: ยังไม่ได้ตรวจกับ Pricing Calculator `[VERIFY]`
- CI/CD ไป Artifact Registry ด้วย Workload Identity Federation, adapter GCS แบบ ADC, TLS ของ Redis, uptime check + alert policy ผ่าน Terraform: เสนอเป็นงานต่อ (ดู ADR-014 Consequences)
