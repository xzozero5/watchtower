# Runbook: สร้าง credential จริงของ Watchtower (เจ้าของทำเองผ่าน web console)

> ตรวจเอกสารทางการ 2026-11-01 · ตรวจกับโค้ดบน `main` 2026-11-02 · **agent ห้ามทำตามคู่มือนี้แทนเจ้าของ** (AGENTS.md `[ASK-HUMAN]`)
> repo เป็นกลาง: ในคู่มือใช้ `example.com` แทนของจริง · **ห้ามวางค่า secret ในแชท, commit, screenshot** (§4)
> ป้าย: `[CONFIRMED]` เห็นในเอกสารทางการหรือโค้ด · `[VERIFY]` ยืนยันถ้อยคำ UI หรือข้อเท็จจริงไม่ได้ · `[ASSUMED]` ค่าเดา · `[ASK-HUMAN]` เจ้าของตัดสิน
> **ยังไม่มี credential ไหนเคยถูกใช้จริง:** ทุก integration ทดสอบใน mock เท่านั้น ขั้นตอนเหล่านี้ยังไม่เคยรันครบ `[VERIFY]` · deploy ดู [staging-gcp.md](staging-gcp.md), ADR-014

## 1. ตารางสรุป

"ต้องมี" = ขาดแล้ว pilot ใช้งานจริงไม่ได้ · "ถ้าใช้" = ต้องมีเฉพาะถ้าเปิด channel/ฟีเจอร์นั้น · "ยังไม่ต้อง" = โค้ดยังไม่อ่าน หรือเป็น phase หลัง

| Credential | ใช้ทำอะไร | ก่อน pilot? | ใครสร้างได้ | ค่าไปที่ไหน |
|---|---|---|---|---|
| Secrets ของระบบ: `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `PORTAL_TOKEN_SECRET` | เซ็น session, เข้ารหัส credential ใน DB, เซ็นลิงก์ติดตาม | **ต้องมี** | เจ้าของ (สร้างในเครื่องเอง) | env file เท่านั้น |
| รหัสผ่าน Postgres / `APP_DB_PASSWORD` / MinIO (`S3_*`) | DB, object storage | **ต้องมี** (ห้ามใช้ค่า default นอก laptop) | เจ้าของ | env file / Secret Manager |
| Break-glass admin | ทางเข้าเมื่อ Google ล่ม + สร้าง `head` คนแรก | **ต้องมี** | เจ้าของ | CLI (stdin) หรือ env file |
| Google OIDC (`GOOGLE_OIDC_CLIENT_ID/_SECRET`, `GOOGLE_ALLOWED_DOMAIN`) | staff sign-in | **ต้องมี** (production บังคับ) | Owner ของ GCP project ที่อยู่ใต้ Cloud Organization | env file เท่านั้น |
| SMTP (`SMTP_USER/_PASSWORD`, `SMTP_RELAY_HOST/_PORT`, `SMTP_FROM`) | magic link / tracking link ของลูกค้า portal | **ต้องมี** ถ้า pilot ใช้ portal | Workspace admin หรือผู้ให้บริการ relay | env file เท่านั้น |
| Gmail แบบ (a) OAuth กล่อง support (`GMAIL_OAUTH_CLIENT_ID/_SECRET`) | อ่าน/ส่งเมลของกล่องเดียว (**ค่าแนะนำ**, po #4) | **ต้องมี** (a หรือ b) | GCP Owner + คนที่ถือกล่องกด consent | หน้า admin หรือ env file |
| Gmail แบบ (b) service account + domain-wide delegation | เหมือนข้างบน | ทางเลือก | **Workspace super admin** + คนมีสิทธิ์สร้าง SA key | `GMAIL_SERVICE_ACCOUNT_JSON_PATH`, `GMAIL_IMPERSONATE_USER` |
| Pub/Sub (topic + push subscription + service account) | Gmail แจ้งเมลใหม่ | **ต้องมี** ถ้าใช้ Gmail จริง | Owner GCP project | `PUBSUB_PROJECT_ID`, `PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT` |
| LINE Messaging API (`LINE_CHANNEL_ID/_SECRET/_ACCESS_TOKEN`) | รับ/ตอบ LINE OA | ถ้าใช้ LINE | Admin ของ LINE OA | หน้า admin หรือ env file |
| LINE Login channel | ผูกตัวตน LINE กับ contact | **ยังไม่ต้อง** (T-103f ยังไม่มี live provider) | Admin ของ provider | — |
| Discord webhook (`DISCORD_WEBHOOK_URL`, `_URGENT`) + `DISCORD_CHANNEL_MAP` | แจ้งเตือน ticket ใหม่ | ถ้าใช้ | ผู้มีสิทธิ์ Manage Webhooks | หน้า admin หรือ env file |
| AI: `ANTHROPIC_API_KEY` + `AI_MODEL_*` + `AI_MODEL_PRICES` | classify, draft, สรุป | **ต้องมี** ถ้า pilot จะดูคุณภาพ AI (ไม่มี = mock) | Org admin ของ Anthropic Console | key: หน้า admin หรือ env · ที่เหลือ env |
| Alert/deploy: `ALERT_PUSH_*`, `ALERT_WEBHOOK_SECRET`, `ALERT_HEARTBEAT_SECRET`, `DEPLOY_WEBHOOK_SECRET` | รับ alert จาก GCP, heartbeat, deploy event (Phase 2) | ถ้าใช้ Phase 2 จริง | เจ้าของ + Owner GCP | §3.11 |
| AI read-only DB: `AI_DB_USER/_PASSWORD`, `AI_READONLY_DATABASE_URL` | เครื่องมือ investigate ของ AI (N2) | ต้องมีถ้าจะเปิดเครื่องมือ logs/data/repo | เจ้าของ | env file เท่านั้น · §3.11 |
| Product DB: `PRODUCT_DB_URL` | data tool และ usage metric | ถ้าใช้ | DBA ของระบบ product | env file เท่านั้น · §3.11 |
| GitHub App, GCP logs/BigQuery จริง, Web Push VAPID, Discord bot, Vertex | ต่อหลัง pilot | **ยังไม่ต้อง** (§3.10) | — | — |

## 2. ลำดับที่แนะนำ และสิ่งที่ต้องรอ public HTTPS

เวลาเป็นการประมาณ `[ASSUMED]`

| ลำดับ | งาน | เวลา | ต้องมี public HTTPS? |
|---|---|---|---|
| 1 | Secrets ของระบบ + รหัสผ่าน DB/MinIO (§3.1) | 15 นาที | ไม่ |
| 2 | Google OIDC (§3.2) | 30–45 นาที | ไม่ (ทดสอบ `http://localhost:4000` ได้ · production ใช้ HTTPS) |
| 3 | Discord webhook (§3.7) | 10 นาที | ไม่ (ยิงออกอย่างเดียว) |
| 4 | LINE OA + Messaging API + secret + token (§3.6 ข้อ 1–4, 7) | 30–60 นาที | ไม่ |
| 5 | GCP: เปิด Gmail API, Pub/Sub topic + สิทธิ์ publisher, service account (§3.3 ข้อ 1–4, §3.5 ข้อ 1–4) | 45 นาที | ไม่ |
| 6 | AI key + model + ราคา (§3.8) | 20 นาที | ไม่ |
| 7 | **หลัง deploy (ADR-014):** Gmail Connect, Pub/Sub push subscription, LINE webhook URL + Verify, redirect URI ของ host จริง, IP ของ SMTP relay, alert subscription | 45 นาที | **ใช่** |

**ทำก่อน deploy ไม่ได้:** Pub/Sub push subscription (ต้องมี endpoint HTTPS ที่ใบรับรองจาก CA จริง), LINE webhook URL (ปุ่ม Verify ต้องมี server ตอบ), redirect URI ของ production, SMTP relay แบบ IP allowlist (ต้องมี egress IP คงที่)

**แถวกล่อง/ช่องทาง:** สร้างที่ Admin → Integrations หรือ CLI (T-131) ก่อน LINE webhook และ Gmail push จะทำงาน `<channelAccountId>` ใน webhook URL ของ LINE คือ id ของแถวนี้

### ตัวแปรที่ยังไม่มีโค้ดอ่าน (ไม่ต้องสร้าง)
| ตัวแปร | สถานะ |
|---|---|
| `PUBSUB_SUBSCRIPTION`, `PUBSUB_EMULATOR_HOST` | สำรอง: เราใช้ push ไม่ใช่ pull |
| `LINE_LOGIN_CHANNEL_ID/_SECRET` | สำรอง: ใช้แค่กันไม่ให้เปิด fake · รอ T-103f |
| `DISCORD_BOT_TOKEN`, `DISCORD_ALERT_CHANNEL_ID`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | สำรอง |
| `GITHUB_APP_*`, `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `WEB_PUSH_*` | สำรอง: เครื่องมือ logs/metrics/repo ยังอ่าน fixture (`AI_TOOL_FIXTURES_DIR`) |
| `VERTEX_*` | worker ยังไม่มีแหล่ง access token: เลือก `vertex` แล้วทุก AI call ล้มและถูกบันทึกเป็น error |
| `CREDENTIAL_LIVE_TEST_ENABLED` | ยังไม่มี live tester: เปิดแล้วได้ `ok:false` "no live check" |

---

## 3. ขั้นตอนต่อ credential

### 3.1 Secrets ของระบบ และรหัสผ่านโครงสร้างพื้นฐาน
**ก่อนเริ่ม:** สร้างโฟลเดอร์ `D:\Works\secret\` (นอก repo) `[ASSUMED]` ตาม `AGENTS.md`.
**ข้อควรระวัง (ทดสอบแล้วบนเครื่องนี้ 2026-11-01):** `openssl rand -base64` ใน Git Bash ต่อท้าย `\r\n` → ใช้ `tr -d '\r\n'` ทุกครั้ง ไม่งั้นค่ามี `\r` ติดไป.

```bash
ENVF=/d/Works/secret/watchtower.env
gen() { printf '%s=%s\n' "$1" "$(openssl rand -base64 "$2" | tr -d '\r\n')" >> "$ENVF"; }   # เขียนลงไฟล์ ไม่พิมพ์ค่า
genhex() { printf '%s=%s\n' "$1" "$(openssl rand -hex "$2" | tr -d '\r\n')" >> "$ENVF"; }  # ตัวอักษร/ตัวเลขล้วน ใช้ใน URL ได้
gen JWT_SECRET 48            # 64 ตัวอักษร (ต้อง >= 32)
gen APP_ENCRYPTION_KEY 32    # base64 ของ 32 bytes พอดี (production บังคับ)
gen PORTAL_TOKEN_SECRET 32   # ตั้งแยก เพื่อให้หมุน APP_ENCRYPTION_KEY ได้โดยลิงก์ลูกค้าไม่พัง
genhex POSTGRES_PASSWORD 24
genhex APP_DB_PASSWORD 24    # แล้วแก้ DATABASE_URL / MIGRATION_DATABASE_URL ให้ใช้รหัสผ่านเดียวกัน (URL-safe)
genhex S3_SECRET_KEY 24      # MinIO root; production บน GCP ใช้ GCS ตาม ADR-014
```
- รันซ้ำ = บรรทัดซ้ำ (append) → ตรวจก่อนว่ายังไม่มีชื่อนั้นในไฟล์.
- **กฎ boot:** ค่าใดมี `change-me` ใน production หรือ `JWT_SECRET`/`APP_ENCRYPTION_KEY` สั้นกว่า 32 bytes เมื่อ `APP_URL` ไม่ใช่ localhost → api/worker ไม่ขึ้น `[CONFIRMED]` (`packages/shared/src/config.ts`).
- **สำรอง `APP_ENCRYPTION_KEY` ใน password manager แยกจาก DB backup** — หายแล้ว credential ที่เก็บใน DB เปิดไม่ได้ (ADR-004/012).
- **Break-glass:** อย่าใส่รหัสผ่านใน env ถ้าเลี่ยงได้ — ตั้ง `BREAK_GLASS_EMAIL`/`_PASSWORD` ว่างไว้ แล้วหลัง migrate รัน CLI อ่านรหัสจาก stdin (รหัส >= 12 ตัวอักษร ตั้งเองแล้วเก็บใน password manager): `read -rs -p 'password: ' P; printf '%s\n' "$P" | pnpm --filter @watchtower/api break-glass admin@example.com; unset P` (ต้องมี `DATABASE_URL` ใน env; ยังไม่ได้ลองรันจริงโดยผม `[VERIFY]`).
- ตรวจว่าตั้งแล้วโดยไม่พิมพ์ค่า:
```bash
chk() { v=$(grep -m1 "^$1=" /d/Works/secret/watchtower.env | cut -d= -f2-); [ -n "$v" ] && echo "$1: set" || echo "$1: EMPTY/missing"; }
chk JWT_SECRET; chk APP_ENCRYPTION_KEY; chk PORTAL_TOKEN_SECRET
```
- **หมุน:** `APP_ENCRYPTION_KEY` ตาม runbook ใน `.env.example` (ตั้ง `PORTAL_TOKEN_SECRET` ก่อน, version +1, `credentials rotate`, `credentials status`) · `JWT_SECRET` เปลี่ยนแล้ว session ทุกอันหลุด (ยอมรับได้).

### 3.2 Google OIDC (staff sign-in)
**ก่อนเริ่ม:** Google Workspace + GCP project ที่อยู่ใต้ Cloud Organization (ตัวเลือก Internal ต้องการ) `[CONFIRMED]`. ผู้ทำ: Owner ของ project.
1. Google Cloud console → เลือก/สร้าง project (เช่น `watchtower-prod`). (ขั้นสร้าง project ไม่ได้ตรวจถ้อยคำ `[VERIFY]`)
2. Menu → **Google Auth platform → Branding**. ถ้าเห็น "not configured yet" กด **Get Started** `[CONFIRMED]`:
   - **App Information:** App name, User support email → Next
   - **Audience: Internal** → Next (Internal = เฉพาะสมาชิกองค์กร, ไม่ต้องทำ verification ของ sensitive/restricted scope) `[CONFIRMED]`
   - **Contact Information:** อีเมล → Next → ติ๊กยอมรับ API Services User Data Policy → **Continue → Create**
   - consent screen ลบทิ้งภายหลังไม่ได้ `[CONFIRMED]`.
3. **Clients → Create Client** → Application type **Web application** → ตั้งชื่อ `[CONFIRMED]`.
4. **Authorized redirect URIs:** `<API_URL>/v1/auth/google/callback` เช่น `https://app.example.com/v1/auth/google/callback` (path จริงจาก `apps/api/src/auth/google-oidc.service.ts`; ต้องตรงทุกตัวอักษรรวม scheme และ `/` ท้าย ไม่งั้น `redirect_uri_mismatch`) · ต้อง HTTPS ยกเว้น localhost; ห้าม wildcard, ห้าม IP ดิบ `[CONFIRMED]`.
   - ทดสอบในเครื่อง: เพิ่มอีกบรรทัด `http://localhost:4000/v1/auth/google/callback` ได้ (localhost ยกเว้น HTTPS) ไม่ต้องรอ deploy
5. กด **Create** → คัดลอก Client ID และ Client secret ใส่ env file ทันที (**secret แสดงครั้งเดียว** ดูย้อนหลังไม่ได้ `[CONFIRMED]`). อย่าเก็บไฟล์ `client_secret.json` ไว้ใน repo.
6. env file: `GOOGLE_OIDC_CLIENT_ID=`, `GOOGLE_OIDC_CLIENT_SECRET=`, `GOOGLE_ALLOWED_DOMAIN=example.com` (โดเมนหลักของ Workspace — โค้ดบังคับว่า claim `hd` ต้องเท่ากับค่านี้ **และ** อีเมลลงท้าย `@ค่านี้`; บัญชี gmail.com ล็อกอินไม่ได้) .
7. ตั้ง `DEV_LOGIN_ENABLED=false` (ถ้า true ขณะมี Google credential → boot ล้ม).
8. **คนแรกที่ล็อกอิน:** Google sign-in ปฏิเสธถ้ายังไม่มี user ที่ `head` สร้างไว้ (`staff_not_provisioned`) → ใช้ break-glass (§3.1) เข้าก่อนแล้วเชิญทีม.
- **Least privilege:** scope `openid email profile` เท่านั้น (ไม่ต้องเพิ่ม Data Access) · Internal.
- **ตรวจ:** `chk GOOGLE_OIDC_CLIENT_ID; chk GOOGLE_OIDC_CLIENT_SECRET; chk GOOGLE_ALLOWED_DOMAIN`.
- **หมุน:** สร้าง secret ใหม่ที่หน้า client (ถ้อยคำปุ่มไม่ได้ตรวจ `[VERIFY]`) → แก้ env → restart api.

### 3.3 Gmail แบบ (a): OAuth ของกล่อง support เดียว (ค่าแนะนำ, T-102e)
**ก่อนเริ่ม:** กล่อง `support@example.com` เป็นผู้ใช้ Workspace เฉพาะ (ไม่ใช่กล่องส่วนตัว) อยู่ใน organization เดียวกับ project
1. Cloud console → **APIs & Services → Library → Gmail API → Enable** `[CONFIRMED]`
2. **Google Auth platform → Audience = Internal** (ถ้าใช้ project เดียวกับ §3.2 ตั้งไว้แล้ว) กล่องนอก organization ต้องใช้ External: สถานะ Testing ทำให้ refresh token **หมดอายุใน 7 วัน** `[CONFIRMED]` และ restricted scope อาจต้องผ่าน verification `[VERIFY]` → ไม่แนะนำ
3. **Data Access:** `https://www.googleapis.com/auth/gmail.readonly` (**restricted**) + `https://www.googleapis.com/auth/gmail.send` (sensitive) ตรงตามนี้ ระบบ**ปฏิเสธ grant ที่มี scope อื่น** `[CONFIRMED]` · Internal ไม่ต้องผ่าน review `[CONFIRMED]`
4. **Clients → Create Client → Web application** → **Authorized redirect URI:** `<API_URL>/v1/admin/integrations/gmail/oauth/callback` (ตรงทุกตัวอักษร)
5. ใส่ `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` ที่ Admin → Integrations หรือ env file
6. ล็อกอินด้วย `head` → Admin → Integrations → **Connect** → บัญชีที่เลือกตอน consent ต้องเป็น `support@example.com` เอง → refresh token ถูกเก็บแบบเข้ารหัส อ่านกลับไม่ได้
- `GMAIL_OAUTH_REFRESH_TOKEN` / `GMAIL_OAUTH_MAILBOX` ใช้เมื่อได้ grant มาจากที่อื่นเท่านั้น: ตั้งแล้ว env ชนะ และปุ่ม Connect ตอบ 409 `credential_env_locked`
- ตั้งครบทั้ง (a) และ (b): แบบที่มี env ชนะแบบที่อยู่ใน DB อย่างเดียว · ถ้าไม่มี env หรือมีทั้งคู่ ใช้ OAuth
- **Blast radius:** เฉพาะกล่องนั้น + 2 scope นี้ (แคบกว่า delegation มาก)
- **ระวัง:** refresh token ใช้ไม่ได้ถ้ากล่องนั้น **เปลี่ยนรหัสผ่าน** (scope Gmail) · ไม่ใช้ 6 เดือน · ถูก revoke · เกิน 100 token ต่อ client `[CONFIRMED]` → ต้อง reconnect
- **หมุน:** reconnect แล้ว revoke อันเก่าที่ myaccount.google.com/permissions `[VERIFY]`

### 3.4 Gmail แบบ (b): service account + domain-wide delegation (มีโค้ดแล้ววันนี้)
**ก่อนเริ่ม:** ต้องมี (1) คนสร้าง service account/key ใน GCP (roles `iam.serviceAccountCreator`, `iam.serviceAccountKeyAdmin`) และ (2) **Workspace super admin** สำหรับ Admin console `[CONFIRMED]`.
**Blast radius — อ่านก่อนทำ:** delegation ให้ service account **ทำเป็นผู้ใช้คนใดก็ได้ในโดเมน** ภายใต้ scope ที่ super admin อนุญาต ไม่ใช่แค่กล่อง support. โค้ดขอแค่ 2 scope และ impersonate 1 user แต่ตัวที่จำกัดความเสียหายเมื่อ key รั่วคือ scope ที่ให้ใน Admin console + การเก็บ key (README ของ adapter `packages/channels/src/gmail/README.md`). Google เตือนเองว่า delegation เข้าถึงข้อมูลของ "all users" และปิด client = แอปหยุดทันที `[CONFIRMED]`. ทำให้เล็กที่สุด: ให้เฉพาะ `gmail.readonly` + `gmail.send`, key นอก repo, กล่องเฉพาะ.
1. เปิด Gmail API (เหมือน §3.3 ข้อ 1).
2. **IAM & Admin → Service accounts → Create service account** ชื่อ `watchtower-gmail` → **Done** โดยไม่ต้องให้ role ใด (ไม่ต้องการ role ในโปรเจกต์) `[CONFIRMED]`.
3. เปิด service account → แท็บ **Keys → Add key → Create new key → JSON → Create** ไฟล์ดาวน์โหลดทันที ดาวน์โหลดซ้ำไม่ได้ `[CONFIRMED]`. ย้ายไป `D:\Works\secret\gmail-sa.json`.
   - ถ้าสร้างไม่ได้: org policy `iam.disableServiceAccountKeyCreation` ถูกบังคับเป็นค่าเริ่มต้นในองค์กรที่สร้างตั้งแต่ 3 พ.ค. 2024 → ต้องให้ผู้ดูแล org policy ยกเว้น project นี้ `[CONFIRMED]`.
4. หา **Client ID** (ตัวเลข): หน้า service account → **Advanced settings** → คัดลอก Client ID `[CONFIRMED]`.
5. Admin console (super admin): **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new** → ใส่ Client ID + scope สองตัว `https://www.googleapis.com/auth/gmail.readonly` และ `https://www.googleapis.com/auth/gmail.send` (ตัวคั่นระหว่าง scope — comma — ไม่ได้ยืนยันจากหน้าเอกสาร `[VERIFY]`) → **Authorize** → **View details** ตรวจว่าเห็นครบทั้งสอง · แก้ client ID ภายหลังไม่ได้ · มีผลเต็มที่ได้ถึง 24 ชม. `[CONFIRMED]`.
6. ค่า: `GMAIL_SERVICE_ACCOUNT_JSON_PATH=<path ไฟล์ที่ process เห็น>`, `GMAIL_IMPERSONATE_USER=support@example.com`.
   - `GMAIL_SERVICE_ACCOUNT_JSON_PATH` = path **บนเครื่องที่รัน compose** · compose mount ไฟล์นี้แบบ read-only เข้า api/worker ให้เอง · ว่าง = ไม่ mount · หรือวาง JSON ที่ Admin → Integrations (`head` เท่านั้น, ไม่เกิน 16,384 ตัวอักษร) · ตั้ง env ไว้แล้ว env ชนะ DB
- **ตรวจ:** `pnpm --filter @watchtower/api credentials status` (ไม่พิมพ์ค่า) หรือ `chk GMAIL_IMPERSONATE_USER`.
- **หมุน:** สร้าง key ใหม่ในแท็บ Keys → ใส่ค่าใหม่ → ลบ key เก่า · ถ้ามีคนที่เข้าถึง key ออกจากทีม ให้หมุนทันที.
- **ยังต้องมีแถวกล่อง:** ดู §2

### 3.5 Pub/Sub สำหรับ Gmail push
**ก่อนเริ่ม:** project เดียวกับที่เปิด Gmail API/สร้าง client (ให้ topic อยู่ project เดียวกับ client ไว้ก่อน — หน้าเอกสารไม่ได้ระบุข้อบังคับ `[VERIFY]`). ข้อ 5 ต้องมี public HTTPS (หลัง deploy).
1. เปิด **Cloud Pub/Sub API** (APIs & Services → Library; ถ้อยคำไม่ได้ตรวจ `[VERIFY]`).
2. **Pub/Sub → Topics → Create topic** → Topic ID `gmail-push` → **เอาเครื่องหมาย "Add a default subscription" ออก** (ค่าเริ่มต้นเป็น pull ที่เราไม่ใช้) → **Create topic** `[CONFIRMED]` (ถ้า org policy จำกัด location ให้ดู message storage policy).
3. หน้า topic → **Show info panel → Permissions → Add principal** → principal `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher** (`roles/pubsub.publisher`) → **Save** `[CONFIRMED]`. ถ้า domain-restricted sharing policy ขวาง ต้องตั้งข้อยกเว้นให้ account นี้ `[CONFIRMED]`.
4. สร้าง service account สำหรับ push: **IAM & Admin → Service accounts → Create** ชื่อ `watchtower-pubsub-push` ไม่ต้องมี role; อีเมลรูปแบบ `watchtower-pubsub-push@<project-id>.iam.gserviceaccount.com` → นี่คือ `GMAIL_PUSH_SERVICE_ACCOUNT` `[CONFIRMED รูปแบบอีเมล]`. SA ต้องอยู่ project เดียวกับ subscription.
5. **(หลัง deploy)** **Subscriptions → Create subscription**: ID `gmail-push-sub`, เลือก topic, **Delivery type = Push**, **Endpoint URL = `https://app.example.com/v1/inbound/gmail/push`** (path จริงจาก `apps/api/src/gmail/gmail-push.controller.ts`; ต้อง HTTPS ใบรับรองจาก CA จริง), ติ๊ก **Enable authentication** → เลือก SA จากข้อ 4 → ช่อง **Audience** ใส่ URL เดียวกับ endpoint (ตั้งชัดเจน เพราะเอกสารไม่ระบุค่า default) → **Create** `[CONFIRMED]`.
   - ถ้า console ขึ้นว่า Pub/Sub service agent (`service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com`) ยังไม่มี Token Creator บน SA นั้น ให้กด **Grant** `[CONFIRMED]`.
   - คนสร้าง subscription ต้องมี `roles/pubsub.editor` และ `iam.serviceAccounts.actAs` บน SA (เช่น Service Account User) `[CONFIRMED]`.
6. env file: `PUBSUB_PROJECT_ID=<project-id>`, `PUBSUB_TOPIC=gmail-push`, `GMAIL_PUSH_AUDIENCE=<string เดียวกับ Audience ข้อ 5 ตรงทุกตัวอักษร>`, `GMAIL_PUSH_SERVICE_ACCOUNT=<อีเมล SA ข้อ 4>`. ตั้งไม่ครบคู่ → ตัวรับ push ตอบ 503.
7. worker เรียก `users.watch` เองทุกวัน (02:15 UTC) และตอน boot เมื่อมีกล่องและ credential ครบ — ไม่ต้องเรียกเอง. ไม่ต้องตั้ง `PUBSUB_SUBSCRIPTION`/`PUBSUB_EMULATOR_HOST` (ไม่ถูกอ่าน).
- **Least privilege:** SA push ไม่ต้องมี role ใด; Gmail publisher ผูกกับ topic เดียว.
- `[VERIFY]` ก่อน live ครั้งแรก: push token ใช้ชุดกุญแจ `https://www.googleapis.com/oauth2/v3/certs` ตามที่โค้ดสมมติ.
- **ตรวจ:** `chk GMAIL_PUSH_AUDIENCE; chk GMAIL_PUSH_SERVICE_ACCOUNT; chk PUBSUB_TOPIC`.

### 3.6 LINE Official Account + Messaging API
**ก่อนเริ่ม:** LINE Business ID · ต้องเป็น admin ของ OA. **สร้าง Messaging API channel ตรงใน LINE Developers Console ไม่ได้อีกแล้ว** ("It's no longer possible to create Messaging API channels directly") ต้องสร้าง OA ก่อนแล้วเปิด Messaging API จาก LINE Official Account Manager `[CONFIRMED]`.
**แผน/โควตา (ไทย, ไม่รวม VAT 7%) `[CONFIRMED]` ตรวจ 2026-11-01:** Free 300 ข้อความ/เดือน (ส่งเพิ่มไม่ได้) · Basic 1,280 บาท/เดือน 15,000 ข้อความ เกินคิด 0.10 บาท · Pro 1,780 บาท 35,000 เกิน 0.06 บาท. Reply ไม่นับโควตา, push นับ (README adapter). ซื้อแผนบน iOS ไม่ได้ ต้องซื้อใน OA Manager. ราคาเปลี่ยนได้ → `[VERIFY]` อีกครั้งก่อนซื้อ. `config/budgets.yaml` ตั้ง `line_oa_plan: free`.
1. สมัคร **Business ID** → กรอกฟอร์ม → ระบบสร้าง OA → ตรวจใน **LINE Official Account Manager** `[CONFIRMED]`. (ถ้าใช้ OA เดิมที่ทีมอื่นใช้ร่วม: rich menu ปิดด้วย flag ตามที่ตัดสินแล้ว — อย่าให้ระบบเราไปทับ)
2. ใน OA Manager เปิด **Messaging API** (ชื่อเมนูไม่ได้ตรวจ `[VERIFY]`) → ถ้าครั้งแรกกรอกชื่อ/อีเมลนักพัฒนา → **เลือก provider** (ตั้งแล้วเปลี่ยน/ลบไม่ได้ — วาง LINE Login channel ไว้ใต้ provider เดียวกัน) `[CONFIRMED]`.
3. LINE Developers Console → เลือก provider → เลือก channel → แท็บ **Basic settings**: คัดลอก **Channel ID** และ **Channel secret** (ต้องเป็น Admin ของ channel) `[CONFIRMED]`.
4. แท็บ **Messaging API** → ส่วน channel access token → ออก **long-lived channel access token** (ไม่หมดอายุ, มีได้ 1 อันต่อ channel; **ออกใหม่ = อันเก่าใช้ไม่ได้ทันที** แต่ต่ออายุอันเก่าได้ถึง 24 ชม.) `[CONFIRMED]` · ชื่อปุ่มไม่ได้ตรวจ `[VERIFY]`.
5. **(หลัง deploy)** แท็บ **Messaging API → Webhook URL → Edit** → `https://app.example.com/v1/inbound/line/<channelAccountId>` (path จาก `apps/api/src/line/line-webhook.controller.ts`; `<channelAccountId>` = UUID ของแถว `channel_account` ดู §2) → **Update → Verify** (ต้องขึ้น Success) → เปิด **Use webhook** · ต้อง HTTPS ใบรับรองจาก CA ที่น่าเชื่อถือ ห้าม self-signed `[CONFIRMED]`.
6. เปิด **Webhook redelivery** ในแท็บเดียวกัน (ปิดเป็นค่าเริ่มต้น; โค้ด dedupe ด้วย `webhookEventId` อยู่แล้ว) `[CONFIRMED]`.
7. **ปิด Greeting messages และ Auto-reply messages:** ในแท็บ Messaging API กด **Edit** ข้างทั้งสอง → จะเปิด OA Manager → ตั้งเป็น **Disabled** (ระบบตอบ auto-ack เองผ่าน policy gate) `[CONFIRMED]`.
8. env/credential store: `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (ต้องครบทั้งสามจึงนับว่า configured).
- **Least privilege:** channel เดียว/OA เดียว. ข้อจำกัดที่รู้: ตอนนี้ **channel secret หนึ่งชุดต่อทั้ง instance** (README adapter) → อย่าลงทะเบียน LINE OA ตัวที่สอง.
- **ตรวจ:** `chk LINE_CHANNEL_SECRET` หรือ `pnpm --filter @watchtower/api credentials status`.
- **หมุน:** ออก access token ใหม่ → ใส่ค่า → (ถ้ารั่ว) revoke อันเก่า · channel secret: issue ใหม่ใน Basic settings `[VERIFY ถ้อยคำปุ่ม]`.

#### LINE Login (ยังไม่ต้องสร้าง — โค้ดยังเป็น fake)
มีแค่ path รอไว้ `GET /v1/line/login/callback`; live provider ยังไม่ถูกสร้าง (T-103f) และ `LINE_LOGIN_CHANNEL_*` ยังไม่ถูกอ่าน. เมื่อถึงเวลา: Developers Console → provider เดียวกัน → แท็บ **Channels → LINE Login** → ตั้งชนิด **Web app** → แท็บ **Basic settings** เอา Channel ID/secret → แท็บ **LINE Login** ใส่ Callback URL `https://app.example.com/v1/line/login/callback` → สถานะเริ่มที่ **Developing** (ใช้ได้เฉพาะ Admin/Tester) ต้องกด Publish จึงเปิดให้ลูกค้า และ **Publish แล้วย้อนกลับไม่ได้** `[CONFIRMED]`. ชื่อ channel ห้ามมีคำว่า "LINE" `[CONFIRMED]`.

### 3.7 Discord webhook (แจ้งเตือน ticket ใหม่)
**ไม่ต้องใช้** bot token, application id, public key, alert channel id (สำรอง).
**ก่อนเริ่ม:** สิทธิ์ **Manage Webhooks** ใน server/ช่อง `[CONFIRMED]`.
1. Discord → Server Settings → Integrations → Webhooks → New Webhook → เลือกช่อง → ตั้งชื่อ → **Copy Webhook URL** (ถ้อยคำ UI `[VERIFY]` — หน้า support ตอบ 403 ตอนตรวจ; ยืนยันได้เพียงว่าต้องมีสิทธิ์ `MANAGE_WEBHOOKS` และ URL มีรูป `/webhooks/{id}/{token}`).
2. ทำได้ 2 อัน: ช่องปกติ (`DISCORD_WEBHOOK_URL`) และช่องด่วน (`DISCORD_WEBHOOK_URL_URGENT`, ไม่บังคับ). โค้ดรับเฉพาะรูป `https://discord.com/api/webhooks/<id>/<token>` (กัน SSRF). **URL ทั้งเส้นคือ secret** — ใครถือก็โพสต์ได้.
3. `DISCORD_CHANNEL_MAP` (JSON, ไม่ใช่ secret, อ่านโดย worker) ว่าง = ทุก ticket ใหม่ไป slot `default`. ตัวอย่าง:
```
DISCORD_CHANNEL_MAP='{"routes":[{"name":"all-tickets","slot":"default","events":["ticket.created"]},{"name":"urgent","slot":"urgent","events":["ticket.created"],"minPriority":"P2"}]}'
```
   - `slot` = `default` | `urgent` · `events` ตอนนี้มีค่าเดียว `ticket.created` · `minPriority` = ระดับนี้หรือเร่งด่วนกว่า (P1 เร่งสุด; P1–P4) · `channels` กรองตามช่องทางที่ ticket เข้ามา (`gmail|line|portal|discord|webhook`) · `name` เป็น `[a-z0-9-]` ยาว <= 40 · map ผิดรูป = worker boot ไม่ขึ้น (ข้อความไม่ echo ค่า). การใส่ single quote รอบ JSON ใน env file ของ compose `[VERIFY]`.
- **Least privilege:** webhook ผูกกับช่องเดียว ไม่มีสิทธิ์อ่าน · ตั้งสิทธิ์ช่องให้ทีมที่ต้องรู้เท่านั้น (ข้อความไม่มีข้อมูลลูกค้า ตามโค้ด).
- **ตรวจ:** `chk DISCORD_WEBHOOK_URL`. **หมุน:** ลบ webhook เดิมใน Discord แล้วสร้างใหม่ (ถ้า URL รั่ว) → ใส่ค่าใหม่.
- ห้ามทดสอบโพสต์ไป server จริงโดยไม่ได้รับไฟเขียวจากเจ้าของ `[ASK-HUMAN]`.

### 3.8 AI: Anthropic และ embedding
**สถานะโค้ด:** worker ต่อ provider แล้ว (T-132) แต่**ยังไม่เคยเรียกจริง** · default `AI_PROVIDER=mock` · เลือก provider แล้วตั้งไม่ครบ: **ไม่ถอยกลับไป mock** ทุก call ล้ม ลง `ai_run` เป็น error และ ingest ใช้ rules · การเรียก AI จริงครั้งแรกเป็นการตัดสินใจของเจ้าของ `[ASK-HUMAN]` · `AI_PROVIDER` ไม่เปลี่ยน autonomy: ทุก intent อยู่ที่ stage ≤ 2 (N3)
**Anthropic Console (https://platform.claude.com):**
1. ตั้งบัญชี org + ช่องทางชำระเงิน (ขั้นนี้ไม่ได้ตรวจถ้อยคำ `[VERIFY]`)
2. **Billing → Spend limits → Set limit / Adjust limit** ใส่เพดานรายเดือนที่ไม่เกินเพดานของ tier (Start $500, Build $1,000) `[CONFIRMED]` ถึงเพดานที่ตั้งเอง = HTTP **400** `invalid_request_error`; ถึงเพดาน tier = HTTP **429** ไม่มี `retry-after` `[CONFIRMED]` → เป็นฉากหลังสำรอง เพดานรายวันของแอปคือ `AI_DAILY_COST_CAP_USD`
3. **Settings → API keys** → **Create key** → ตั้งชื่อ, expiration, **Linked account**: เลือก **service account key** สำหรับของใช้ร่วม (personal key หยุดทำงานเมื่อเจ้าของออกจาก org) → คัดลอกทันที **แสดงครั้งเดียว** `[CONFIRMED]` จะผูกกับ workspace เฉพาะเพื่อตั้ง limit แยกก็ได้ (default workspace ตั้ง spend limit ไม่ได้) `[CONFIRMED]`
4. ค่า: `ANTHROPIC_API_KEY` (หน้า admin หรือ env, env ชนะ) · `AI_PROVIDER=anthropic`
5. **ต้องตั้งเพิ่ม:** `AI_MODEL_DEEP`, `AI_MODEL_STANDARD`, `AI_MODEL_LIGHT` = id ตามที่ผู้ให้บริการเรียก (โค้ดไม่มีชื่อ model) · `AI_MODEL_PRICES` = JSON `{"<model id>":{"inputUsdPerMTok":1,"outputUsdPerMTok":5}}` ใส่ราคาจริงของทุก model ที่เลือก ตัวเลขในตัวอย่างเป็นแค่รูปแบบ · **ไม่มีราคา = call ถูกปฏิเสธ** เพราะเพดานนับไม่ได้
**Vertex AI:** ยังใช้ไม่ได้ (§2) · Claude มีใน `asia-southeast1` หรือไม่ ยืนยันไม่ได้ `[VERIFY]` · ที่ตั้งข้อมูล/PDPA `[ASK-HUMAN]`
**เพดานของแอป (`config/budgets.yaml`, `[ASSUMED]`):** `app_ai_daily` = $1/วัน, 500,000 tokens/วัน, แจ้งเตือนที่ 80% แล้วหยุดที่เพดาน (fail closed → rules) · ทับด้วย `AI_DAILY_COST_CAP_USD`, `AI_DAILY_TOKEN_CAP`, `AI_BUDGET_ALERT_PERCENT` · **$1/วันน่าจะน้อยไปสำหรับ pilot จริง** เจ้าของกำหนด `[ASK-HUMAN]` · PII ถูก redact ก่อนส่ง LLM เสมอ (N4)
**Embedding:** โค้ดอนุญาต `EMBEDDING_PROVIDER=mock` เท่านั้น · ค่าอื่น → api/worker **boot ไม่ขึ้นโดยตั้งใจ** จนกว่าเจ้าของอนุมัติ live embedding + ADR (ปลายทาง network ใหม่ `[ASK-HUMAN]`) · ความหมายจริง: ค้น KB ตอนนี้ใช้ vector จำลอง ไม่ใช่การค้นเชิงความหมาย คุณภาพการค้นจริงยังไม่ได้วัด

### 3.9 SMTP สำหรับอีเมลออกจริง
- **ใช้ทำอะไร:** อีเมลที่ระบบส่งเอง (magic link, ลิงก์ติดตามของลูกค้า portal, status subscription) **คำตอบลูกค้าใน thread ส่งผ่าน Gmail API/LINE ไม่ใช่ SMTP**
- **ตัวแปร:** `SMTP_RELAY_HOST`, `SMTP_RELAY_PORT` (compose ใช้สองตัวนี้ ไม่สนใจ `SMTP_HOST`), `SMTP_USER`, `SMTP_PASSWORD` (ทั้งคู่หรือไม่ใส่เลย, env เท่านั้น), `SMTP_FROM` · พอร์ต 465 = implicit TLS, 587 = STARTTLS
- **production:** worker ปฏิเสธการเชื่อมต่อที่ไม่เข้ารหัสและการส่งแบบไม่ login เว้นแต่ `SMTP_ALLOW_INSECURE=true` (เฉพาะ relay ภายในที่ไว้ใจได้)
- **ทางเลือก `[VERIFY]` ยังไม่ได้ลองจริง:** (1) ผู้ให้บริการ relay หรือบัญชีที่มี user/password (2) Google Workspace **SMTP relay** แบบ IP allowlist: Admin console → Apps → Google Workspace → Gmail → Routing → **SMTP relay service → Configure** → "Only accept mail from the specified IP addresses" → `smtp-relay.gmail.com:587` + TLS `[CONFIRMED]` ต้องมี egress IP คงที่ (Cloud NAT ตาม ADR-014) และต้องตั้ง `SMTP_ALLOW_INSECURE=true` เพราะไม่มี login
- `SMTP_FROM` ต้องเป็นที่อยู่ในโดเมนที่ตั้ง SPF/DKIM แล้ว (เช่น `Watchtower <no-reply@example.com>`) `[ASSUMED]`
- **ตรวจ:** `chk SMTP_FROM; chk SMTP_USER` · **หมุน:** เปลี่ยนรหัสที่ผู้ให้บริการ → แก้ env → restart worker

### 3.10 ต่อหลัง pilot (ไม่ต้องสร้างตอนนี้)
- **GitHub App** (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`), **GCP logs/metrics/BigQuery จริง** (`GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`): ตอนนี้ client อ่าน fixture · เมื่อต่อจริง SA ต้อง read-only เท่านั้น (N2) และเป็นปลายทาง network ใหม่ `[ASK-HUMAN]`
- **Web Push VAPID** (`WEB_PUSH_*`): ต้องเจ้าของอนุมัติก่อนมีโค้ด · ว่าง = แจ้งเตือนใน app เท่านั้น
- **Discord bot**, **LINE Login live** (T-103f), **Vertex**: ดู §2

### 3.11 Phase 2: alert, deploy, เครื่องมือ investigate
**Alert จาก GCP ผ่าน Pub/Sub:** subscription แบบ Push → endpoint `<API_URL>/v1/inbound/alerts/gcp`, Enable authentication → `ALERT_PUSH_AUDIENCE` (string เดียวกับ Audience ตรงทุกตัวอักษร), `ALERT_PUSH_SERVICE_ACCOUNT` (อีเมล SA ที่เซ็น) · ขั้นตอนเหมือน §3.5 ข้อ 4–5 · ว่างทั้งคู่ = route ตอบ 503
**Secret ของ machine receiver** (HMAC-SHA256 ในหัว `X-Watchtower-Signature` ทับ `<t>.<route>.` + body, แยกตัวต่อจุดประสงค์):
```bash
genhex ALERT_WEBHOOK_SECRET 32     # /v1/inbound/alerts/webhook
genhex ALERT_HEARTBEAT_SECRET 32   # /v1/inbound/heartbeats/:slug
genhex DEPLOY_WEBHOOK_SECRET 32    # /v1/inbound/deploys
```
ว่าง = route ตอบ 401 ทุกครั้ง · ใส่ env หรือหน้า admin (`alerting`) · ระบบต้นทางต้องเซ็นด้วยค่าเดียวกัน · **หมุน:** สร้างใหม่ → แก้ทั้งสองฝั่งพร้อมกัน

**AI read-only DB (N2):** `genhex AI_DB_PASSWORD 24` + ตั้ง `AI_DB_USER=watchtower_ai` `[ASSUMED]` → `pnpm db:migrate` สร้าง login ที่อ่านได้แค่ view `ai_v_*` → `AI_READONLY_DATABASE_URL=postgres://<AI_DB_USER>:<AI_DB_PASSWORD>@<host>:5432/watchtower` · ว่าง = เครื่องมือ logs/data/repo ปิด · ห้ามตั้ง `AI_TOOLS_WITHOUT_READONLY_LOGIN=true` นอก local

**Product DB:** ให้ DBA สร้าง login read-only ที่อ่านได้เฉพาะคอลัมน์ที่ไม่ใช่ข้อมูลส่วนบุคคล → `PRODUCT_DB_URL` (รหัสผ่าน 16 ตัวขึ้นไป) · ว่าง = data tool ตอบ "not connected" · ทดลองในเครื่องดู `examples/metrics/README.md`, `PRODUCT_MOCK_RO_PASSWORD` ใช้กับ mock เท่านั้น · น้ำหนัก Health Score ค่าเริ่มต้นเป็น `[ASSUMED]`

**Status page:** `STATUS_PAGE_PUBLIC=false` เป็นค่าเริ่มต้น · การเปิดสาธารณะเป็นการตัดสินใจของเจ้าของ `[ASK-HUMAN]`

---

## 4. กฎความปลอดภัย
1. **ห้ามวางค่า secret** ในแชทกับ AI, commit, issue, screenshot, หรือ log. ถ้าเผลอ = ถือว่ารั่ว → หมุนที่ผู้ให้บริการทันที แล้วค่อยกรอกค่าใหม่ (ADR-012: `rotate` ของเราไม่ช่วยถ้าค่า plaintext รั่ว).
2. **ที่เก็บ:** infra secret (`JWT_SECRET`, `APP_ENCRYPTION_KEY`, รหัส DB/MinIO) = env file นอก repo (`D:\Works\secret\watchtower.env` `[ASSUMED]` ตาม AGENTS.md) หรือ Secret Manager. credential ของ integration (Gmail, LINE, Discord, AI) = env file **หรือ** หน้า admin (เข้ารหัสใน DB, `head` เท่านั้น, อ่านกลับไม่ได้, audit ไม่มีค่า) — **ถ้าตั้งทั้งสองที่ env ชนะ** (ADR-004/012)
3. **compose:** ตัวแปรใน `.env.example` ถูกส่งเข้า container ผ่าน `x-app-env` · อ่าน env file นอก repo ด้วย `docker compose --env-file D:\Works\secret\watchtower.env …` `[ASSUMED]`
4. **`CREDENTIAL_LIVE_TEST_ENABLED=false` (default):** ปุ่ม "Test connection" ใช้ของจำลองเสมอ ไม่ยิงออกนอกเครื่อง · การเปิด = ตัดสินใจของเจ้าของ `[ASK-HUMAN]` และตอนนี้ยังไม่มี live tester
5. **การติดต่อจริงครั้งแรก** (webhook ครั้งแรกจาก Google/LINE, Gmail `watch` ครั้งแรก, ข้อความถึงลูกค้าจริง, โพสต์ลง Discord จริง, การเรียก AI จริง) ต้องได้ไฟเขียวจากเจ้าของเป็นลายลักษณ์อักษรทีละครั้ง `[ASK-HUMAN]`. contract test live (`CONTRACT_LIVE=1`, `CONTRACT_LIVE_WRITE=1`) ไม่มีใคร set ใน repo.
6. **agent ไม่ใช้ credential เหล่านี้** — เจ้าของกรอกเอง; agent ตรวจได้แค่ "มี/ไม่มี" (`chk`, `credentials status`).
7. ใช้บัญชีเฉพาะ (กล่อง support เฉพาะ, SA เฉพาะ, LINE OA/Discord webhook เฉพาะ) และให้สิทธิ์ขั้นต่ำเสมอ; เปิด 2-step verification ให้ผู้ที่สร้างของพวกนี้.

## 5. แหล่งอ้างอิง (ตรวจ 2026-11-01)
- Google Auth platform setup: https://support.google.com/cloud/answer/15544987 · https://developers.google.com/workspace/guides/configure-oauth-consent
- OAuth web client / redirect URI: https://developers.google.com/identity/protocols/oauth2/web-server · OIDC `hd`: https://developers.google.com/identity/openid-connect/openid-connect
- Refresh token expiry: https://developers.google.com/identity/protocols/oauth2
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes · enable API: https://developers.google.com/workspace/guides/enable-apis
- Gmail push: https://developers.google.com/workspace/gmail/api/guides/push
- Domain-wide delegation: https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation (redirect จาก https://support.google.com/a/answer/162106)
- Service account / key: https://docs.cloud.google.com/iam/docs/service-accounts-create · https://docs.cloud.google.com/iam/docs/keys-create-delete
- Pub/Sub: https://docs.cloud.google.com/pubsub/docs/create-topic · https://docs.cloud.google.com/pubsub/docs/create-push-subscription · https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions · https://docs.cloud.google.com/pubsub/docs/access-control
- Workspace SMTP relay: https://knowledge.workspace.google.com/admin/gmail/advanced/route-outgoing-smtp-relay-messages-through-google
- LINE: https://developers.line.biz/en/docs/messaging-api/getting-started/ · https://developers.line.biz/en/docs/messaging-api/building-bot/ · https://developers.line.biz/en/docs/basics/channel-access-token/ · https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/ · https://developers.line.biz/en/docs/line-developers-console/overview/ · https://developers.line.biz/en/docs/line-login/getting-started/ · ราคา TH: https://lineforbusiness.com/th/service/line-oa-features/broadcast-message
- Discord: https://docs.discord.com/developers/resources/webhook (หน้า support.discord.com ตอบ 403 → UI path = `[VERIFY]`)
- Anthropic: https://platform.claude.com/docs/en/api/rate-limits · https://platform.claude.com/docs/en/get-api-key
- Vertex AI Claude: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude (ดึงเนื้อหา region ไม่ได้ → `[VERIFY]`)
- ในโค้ด/ADR: `packages/shared/src/config.ts`, `packages/shared/src/features/credentials.ts`, ADR-004, ADR-012, `packages/channels/src/gmail/README.md`, `packages/channels/src/line/README.md`, `packages/channels/src/discord/README.md`, ADR-014
