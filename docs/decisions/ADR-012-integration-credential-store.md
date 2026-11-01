# ADR-012 — Integration credential store: ตาราง `integration_credential`, envelope encryption, หมุนกุญแจ (T-116a)

- **Status:** Proposed 2026-11-01 · แก้ (amends) ADR-004 ในส่วนที่ ADR-004 ทิ้งไว้เป็น "envelope encryption … ต้องมีวิธีหมุนกุญแจ" · รอ `security-reviewer` (N7 — ผู้เขียนคนละคนกับผู้ตรวจ) และ `po`
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** `backend-dev` เสนอ → main thread / เจ้าของรับรอง
- **Context:**
  - ADR-004 (Accepted): infra secret อยู่ใน environment; credential ของ integration อยู่ใน environment **หรือ** DB แบบเข้ารหัส ตั้งผ่านหน้า admin โดย `head`, อ่านกลับไม่ได้, audit ไม่มีค่า, environment ชนะ, มีปุ่มทดสอบ, มีวิธีหมุนกุญแจ
  - ก่อนงานนี้ที่เก็บเดียวที่มีคือ `channel_account.config_encrypted` (bytea ว่าง ไม่มีโค้ดใดเขียนหรืออ่าน) ซึ่งผูกกับ "หนึ่งแถวต่อกล่อง/ช่องทาง" ทั้งที่ credential ส่วนใหญ่เป็นระดับ integration (LINE channel secret, Discord bot token, ANTHROPIC key ของ AI provider ไม่ใช่ channel)
  - มี primitive อยู่แล้ว: `@watchtower/shared/secret-box` (`deriveSubkey` = HKDF-SHA-256, `sealSecret`/`openSecret` = AES-256-GCM พร้อม AAD) ใช้กับ outbox (ADR-006) — งานนี้ใช้ซ้ำ ไม่เขียน crypto ใหม่ (N6)
  - PRD §6.7 ("envelope encryption with a KMS key or local master key"), UI spec §12 (write-only, ไม่แสดงแม้ mask หรือความยาว, "Set by environment variable NAME"), `docs/09-SECURITY.md` §1, `docs/plans/phase-1-breakdown.md` §D T-116 / §G ข้อ 10

## Decision

### 1. ตาราง `integration_credential` แยกจาก `channel_account` (migration `0010`)
- หนึ่งแถว = หนึ่ง field ของหนึ่ง integration: `UNIQUE (integration, field)` · `integration` และ `field` มาจาก **catalog ในโค้ด** (`INTEGRATION_CATALOG` ใน `packages/shared/src/features/credentials.ts`) เท่านั้น — API ปฏิเสธชื่อที่ไม่อยู่ใน catalog ดังนั้นเพิ่ม integration = เพิ่มบรรทัดใน catalog ไม่ต้อง migrate
- คอลัมน์: `value_sealed text` (ค่า เข้ารหัสด้วย DEK), `dek_wrapped text` (DEK ที่ห่อด้วย KEK), `key_version integer` (เวอร์ชันของ KEK ที่ห่อ), `created_at/updated_at`, `created_by/updated_by` (`users.id`, `ON DELETE SET NULL`) · **ไม่มีคอลัมน์ plaintext, ไม่มี hash ของค่า, ไม่มีความยาว**
- สิทธิ์ app role: ค่า default privileges ของ `0001` (SELECT/INSERT/UPDATE/DELETE) พอดีกับที่ต้องใช้ — ไม่ GRANT เพิ่ม ไม่มี TRUNCATE
- **`channel_account.config_encrypted` ถูก drop ใน `0010`** (ไม่มีโค้ดใช้; มีสองที่เก็บ ciphertext = ความเสี่ยงที่ใครสักคนเริ่มเขียนค่าลงที่ผิดที่ที่ไม่มี rotation) · migration **ปฏิเสธที่จะรัน** (RAISE EXCEPTION) ถ้ามีแถวที่คอลัมน์นั้นไม่ว่าง เพื่อไม่ให้ข้อมูลหายเงียบ ๆ · down: เพิ่มคอลัมน์กลับเป็น `bytea NULL` (ว่าง) · ถ้าเจ้าของไม่เห็นด้วย ให้ถอด `ALTER TABLE channel_account DROP COLUMN` ออกจาก `0010` ก่อน merge — ไม่มีส่วนอื่นพึ่งมัน
- credential **ต่อกล่องเมล** (po #4: หลาย mailbox, OAuth refresh token ของแต่ละกล่อง — T-102) ยังไม่รองรับในงานนี้: เมื่อถึงเวลา เพิ่ม `channel_account_id uuid NULL REFERENCES channel_account ON DELETE CASCADE` และเปลี่ยน unique เป็นแบบ partial 2 ตัว (migration ของ T-102) · env ไม่มีแนวคิดต่อกล่อง จึงไม่ขัดกับกฎ "environment ชนะ" `[ASSUMED]`

### 2. Envelope encryption (AES-256-GCM, DEK ต่อแถว, KEK จาก HKDF)
```
DEK  = randomBytes(32)                               -- ใหม่ทุกครั้งที่เขียนค่า
value_sealed = sealSecret(DEK, value, aad = "watchtower/credential/v1|value|<integration>|<field>")
KEK_v = HKDF-SHA-256(root_v, salt "watchtower-subkeys", info "watchtower/credentials/kek/v1")   -- root_v = APP_ENCRYPTION_KEY ของเวอร์ชัน v
dek_wrapped = sealSecret(KEK_v, base64url(DEK), aad = "watchtower/credential/v1|dek|<integration>|<field>|kv<v>")
```
- AAD ผูกค่า/DEK กับ `(integration, field)` (และ key version สำหรับ DEK) → ย้าย ciphertext ไปแถวอื่นหรือแก้ `key_version` ด้วยมือแล้วเปิดไม่ออก (GCM tag ไม่ผ่าน) · ทดสอบแล้วในชุด test
- ใช้ `KEY_LABELS.credentialKek` ใหม่ — label แยกจาก outbox/email-tag ตามหลักเดิม ("ไม่ใช้ label ซ้ำ")
- **`KmsPort`** (`packages/shared/src/credential-box.ts`): `currentKeyVersion`, `wrap(dek, context) → { wrapped, keyVersion }`, `unwrap(wrapped, keyVersion, context) → dek` (async ทั้งคู่) · ตัว implement ตอนนี้คือ `LocalKms` (HKDF จาก `APP_ENCRYPTION_KEY` ตามด้านบน) · KMS บน cloud (GCP KMS ฯลฯ) = implement `KmsPort` ตัวใหม่ **โดยไม่เปลี่ยนตาราง/store/API** — ไม่มี cloud SDK ในงานนี้ (ปลายทาง network ใหม่ = `[ASK-HUMAN]` ตอนถึงเวลา)
- ค่าที่ถอดรหัสแล้วอยู่ใน memory ของ process ชั่วคราวเท่านั้น: `store.resolve()` คืนค่าให้ adapter · ไม่ cache

### 3. `key_version` และการหมุนกุญแจ (`credentials rotate`)
- env: `APP_ENCRYPTION_KEY` (ตัวปัจจุบัน) + `APP_ENCRYPTION_KEY_VERSION` (จำนวนเต็ม ≥ 1, default 1) · ระหว่างหมุน: `APP_ENCRYPTION_KEY_PREVIOUS` + `APP_ENCRYPTION_KEY_PREVIOUS_VERSION` (ต้องต่ำกว่าเวอร์ชันปัจจุบัน) — รองรับ **ตัวก่อนหน้าหนึ่งตัว**
- ขั้นตอน (runbook): (1) สร้างกุญแจใหม่ → ตั้งเป็น `APP_ENCRYPTION_KEY` + `_VERSION=N+1`, ย้ายตัวเก่าไป `_PREVIOUS` + `_PREVIOUS_VERSION=N` (2) deploy / restart api+worker (3) รัน CLI `node dist/cli/credentials.js rotate` — เปิด DEK ของทุกแถวที่ `key_version <> current` ด้วย KEK เก่า แล้ว **ห่อใหม่ด้วย KEK ปัจจุบัน** (ไม่แตะ `value_sealed` เพราะค่าไม่เปลี่ยน) ทีละแถวใน transaction ของตัวเอง (`UPDATE … WHERE id = $1 AND key_version = $old` กันแข่งกับการเขียนใหม่) · idempotent: รันซ้ำได้, รันตอนที่ไม่มีอะไรต้องหมุน = 0 แถว (4) `credentials status` ต้องแสดงว่าทุกแถวเป็นเวอร์ชันปัจจุบัน แล้วจึงลบ `_PREVIOUS` ออกจาก environment
- **`rotate` ทำแค่ hygiene ไม่ใช่การกู้สถานการณ์ที่ค่ารั่ว (security review K-1):** มัน re-wrap เฉพาะ DEK ใต้ KEK ใหม่ ส่วน `value_sealed` และ DEK เดิมไม่เปลี่ยน → ใครถือ DB dump + root key เก่าแล้ว**ยังเปิดค่าเดิมได้** · `rotate --reseal` สร้าง DEK ใหม่ทุกแถวแล้ว seal ค่าใหม่ (เปิดค่าด้วยกุญแจที่มี → seal ใหม่ใต้เวอร์ชันปัจจุบัน; idempotent; ทำทีละแถวแบบ optimistic) ทำให้ dump เก่า + root key เก่าใช้กับแถวใหม่ไม่ได้ · **ทั้งสองแบบไม่ช่วยถ้า root key หรือค่า plaintext รั่วไปแล้ว:** runbook ต้อง (1) หมุน credential นั้นที่ผู้ให้บริการ (LINE/Discord/Google/Anthropic ฯลฯ) (2) กรอกค่าใหม่ผ่านหน้า admin (3) จึงหมุนกุญแจ + `--reseal` และเอา `_PREVIOUS` ออก
- แถวที่เปิดไม่ได้ (ไม่มีกุญแจของเวอร์ชันนั้น หรือ tag ไม่ผ่าน) ถูกนับเป็น `failed` พร้อม id/integration/field (ไม่มีค่า) และ CLI จบด้วย exit 1 โดยไม่หยุดแถวอื่น
- CLI เขียน audit `integration.credential.rotate` เสมอ (actor `system:credentials-cli`; metadata = mode, จำนวนแถว, เวอร์ชันต้นทาง/ปลายทาง; ไม่มีค่า) · ถ้ารันพังกลางทางจะเขียนแถว `failure` พร้อม `aborted: true, rowsDone` (K-7)
- **ผลข้างเคียงที่ต้องรู้ (ยอมรับ):** `APP_ENCRYPTION_KEY` เป็นรากของ subkey อื่นด้วย (outbox ADR-006, audit email tag, และ `PORTAL_TOKEN_SECRET` เมื่อเว้นว่าง ADR-007) การเปลี่ยนรากทำให้ job outbox ที่รออยู่เปิดไม่ออก (ถูกทิ้ง, ลูกค้าขอลิงก์ใหม่ — พฤติกรรมเดิมที่ `.env.example` บอกไว้), email tag เปลี่ยนค่า, และลิงก์ tracking เดิมใช้ไม่ได้ถ้าไม่ได้ตั้ง `PORTAL_TOKEN_SECRET` แยก → runbook ต้องบอกให้ตั้ง `PORTAL_TOKEN_SECRET` ให้ชัดก่อนหมุน และทำตอนที่ outbox ว่าง · ทางเลือกที่ไม่ผูกกับราก (กุญแจ KEK แยกต่างหาก) ถูกตัดตามโจทย์ ("KEK derive จาก `APP_ENCRYPTION_KEY`") — KMS port เปิดทางไว้แล้ว

### 4. Environment ชนะ DB ทุก key
- `store.resolve(integration)` ต่อ field: ถ้า env var ที่ catalog ระบุมีค่า (ไม่ว่าง) → `source: 'env'`, ค่าจาก env · ไม่งั้นถ้ามีแถวใน DB → `source: 'db'` · ไม่งั้น `source: 'none'`
- field ที่ env ตัวแปรเป็น **path ของไฟล์** (`GMAIL_SERVICE_ACCOUNT_JSON_PATH`, `GITHUB_APP_PRIVATE_KEY_PATH`) catalog ระบุ `envKind: 'file'`: resolve อ่านไฟล์นั้น (สถานะรายการ/list ตรวจแค่ว่า env ตั้งไว้ ไม่เปิดไฟล์)
- `PUT` field ที่ถูกล็อกด้วย env → `409 credential_env_locked` (UI spec §12: ช่องถูก disable) · `DELETE` แถว DB ที่ถูกบัง env ได้ (ล้างของที่ไม่ได้ใช้)
- adapter ทุกตัวอ่านผ่าน `store.resolve()` ไม่อ่าน `process.env` เอง (ADR-004)

### 5. Write-only ผ่าน HTTP — `/v1/admin/integrations`
สิทธิ์: `@RequirePermission('integration.manage')` ทุก route · ตรวจแล้ว: ใน `DEFAULT_ROLE_PERMISSIONS` มีเฉพาะ `head` (ตรงกับ PRD §2.2 และ ADR-004 "head เท่านั้น") — ไม่เพิ่ม permission ใหม่ ไม่ต้อง migrate permission

| Route | ทำอะไร | audit action |
|---|---|---|
| `GET /v1/admin/integrations` | รายการทุก integration ใน catalog + สถานะรายเขตข้อมูล + `testMode` (`mock`/`live`) | — (อ่าน) |
| `PUT /v1/admin/integrations/:integration` | body `{ fields: { <field>: "<value>" } }` เขียน/แทนที่เฉพาะ field ที่ส่ง · คืนสถานะ (ไม่มีค่า) · key ต้องเป็นชื่อ field ใน catalog (enum) และเป็นของ integration นั้น (ตรวจด้วย `Object.hasOwn`) มิฉะนั้น 400 ข้อความกลาง ไม่สะท้อนชื่อที่ส่งมา (K-3, K-4) | `integration.credential.set` |
| `DELETE /v1/admin/integrations/:integration/fields/:field` | ลบแถวของ field นั้น (204) | `integration.credential.delete` |
| `POST /v1/admin/integrations/:integration/test` | ทดสอบ (body `{ fields? }` = ค่าที่ยังไม่ได้บันทึก) → `{ ok, mode, identity, message, checkedAt }` | `integration.credential.test` |

- สถานะต่อ field: `{ field, label, secret, required, configured, source: 'env'|'db'|'none', envVar, updatedAt, updatedBy }` (`updatedBy` = `{ id, name }` หรือ null; ค่า `updatedAt/updatedBy` มีเฉพาะ `source: 'db'`) · ของ integration: `status: 'not_configured'|'partial'|'configured'`
- **ไม่คืน last-4/mask/ความยาว** — เข้มกว่าที่ task อนุญาต ("masked last-4 at most") เพราะ UI spec §12 ห้ามแม้ mask หรือความยาว · ถ้าเจ้าของต้องการ last-4 เพิ่มได้โดยไม่แตะ schema DB (ต้องถอดรหัสตอน list = ไม่ทำ)
- ทุก field เป็น write-only รวมที่ไม่ใช่ secret (เช่น channel id) — เรียบง่ายกว่าและ UI แสดงสถานะเดียวกัน; ตัวตนที่ไม่ลับเห็นได้จากผลทดสอบ
- 409 ของ field ที่ env ล็อกใช้ `code: credential_env_locked` (K-5) · `test` จำกัด **10 ครั้ง/นาที/คน** (Redis `RateLimiter`, นับหลังตรวจ request แล้ว; เกิน = 429 `rate_limited`) `[ASSUMED]` (K-2)
- ค่า: trim ช่องว่างหัวท้าย, 1–16 384 ตัวอักษร (service account JSON / PEM) · ชื่อ field ที่ไม่อยู่ใน catalog → 400
- audit: ใช้ `AuditService.recordInTransaction` ใน transaction เดียวกับการเขียน · metadata มี**ชื่อ field**เท่านั้น ไม่มีค่า ไม่มี hash · response error / log ไม่ echo ค่า — มี test จับ log และ response แล้ว grep หา plaintext
- ไม่มีการอ่านค่ากลับผ่าน HTTP ในทุกกรณี รวมถึง `test` (คืนแค่ identity ที่ไม่ลับ เช่น ชื่อ bot จาก adapter ในอนาคต)

### 6. ปุ่มทดสอบ: hook `testConnection` ต่อ adapter, mock ใช้ fake เสมอ
- `ConnectionTester` ต่อ integration: `fake(config)` (offline, deterministic — ตรวจว่ามี field ที่จำเป็นครบ, คืน `identity: "mock:<integration>"`) และ `live?(config)` ที่ adapter จะเติมตอน T-102/T-103/T-104 · registry (`ConnectionTesterRegistry.register`) ให้ module ของ adapter เสียบเข้ามาโดยไม่แก้ credentials module
- config ที่ใช้ทดสอบ = ค่า**ที่มีผลจริง**: env > ค่าที่ส่งมาในคำขอ (ยังไม่บันทึก) > ค่าใน DB
- **เงื่อนไขบังคับก่อน T-116b / live tester ตัวแรกจะ merge (security review K-2):** (1) live tester ต้องมี **destination allow-list** — ยิงได้เฉพาะ host ของผู้ให้บริการนั้นตามที่ PRD §11/ADR ระบุ ห้ามรับ URL/host จากค่าที่ผู้ใช้กรอก (กัน SSRF และกันส่งความลับไปปลายทางอื่น) (2) **ห้ามผสมค่าที่ส่งมาในคำขอ (unsaved) กับ secret ที่เก็บไว้ของ integration เดียวกัน** ในการทดสอบ live — ถ้ามี field ใดถูกส่งมาแทน ต้องส่งครบทุก field ที่เป็น secret ของ integration นั้น ไม่งั้นปฏิเสธ (กันการเอาค่าที่ผู้โจมตีกรอกไปพร้อม secret จริงยิงไปปลายทางที่ผู้โจมตีคุม) (3) rate limit ของ endpoint `test` (ข้างบน) ต้องคงอยู่ · `security-reviewer` ตรวจซ้ำก่อนเปิด flag
- **`CREDENTIAL_LIVE_TEST_ENABLED` (default `false`):** ปิด = ใช้ `fake` เสมอ ไม่มี network · เปิด = ใช้ `live` ถ้า adapter มี ไม่มี = ตอบ `ok:false` "no live check" · **การเปิด flag นี้และ implement `live` ที่ยิงออกนอกเครื่อง = `[ASK-HUMAN]`** (credential จริง + ปลายทาง network)

## Options considered
- **เก็บใน `channel_account.config_encrypted` (bytea เดียวต่อกล่อง)** — ไม่มี DB migration ใหม่ แต่ผูกกับ channel (AI provider/GitHub ไม่ใช่ channel), เขียนทั้งก้อน (เปลี่ยน field เดียวต้องส่งทุก field → UI ต้องอ่านกลับ ซึ่งขัด write-only), ไม่มีเวอร์ชันกุญแจต่อแถว → ตัดทิ้ง
- **เข้ารหัสด้วย `APP_ENCRYPTION_KEY` ตรง ๆ (ไม่มี DEK)** — เรียบง่าย แต่หมุนกุญแจต้องถอดรหัส/เข้ารหัสทุกค่า (ต้องเห็น plaintext ในกระบวนการหมุน) และเปลี่ยนไป cloud KMS ไม่ได้โดยไม่เขียนข้อมูลทั้งหมดใหม่ → เลือก envelope
- **ตั้งกุญแจ KEK แยก (`CREDENTIAL_KEK`) ไม่ผูกกับ `APP_ENCRYPTION_KEY`** — หมุนได้โดยไม่กระทบ outbox/portal แต่เพิ่ม secret ให้ผู้ deploy จัดการ และขัดโจทย์ → ไม่เลือก; `KmsPort` เปิดทางไว้
- **คืน last-4 ใน list** — ช่วยแยก key หลายตัว แต่ต้องถอดรหัสทุกครั้งที่ list และขัด UI spec §12 → ไม่ทำ
- **env ชนะ vs. DB ชนะ** — ADR-004 ตัดสินแล้ว (env ชนะ) ทำตาม

## Consequences
- ทุก adapter (T-102/T-103/T-104/T-106f/T-107/T-105) ต้องอ่านผ่าน `createCredentialStore(...).resolve(integration)`; ห้าม `process.env.LINE_*` ตรง ๆ
- ADR-004 เพิ่ม: ที่เก็บ = ตาราง `integration_credential` (ไม่ใช่ `channel_account.config_encrypted`) · `docs/01-PRD.md` §7 บรรทัด `channel_account(... config_encrypted ...)` ล้าสมัยหลังงานนี้ — main thread แก้ตอน merge
- DB backup มี ciphertext + DEK ที่ห่อแล้ว; กุญแจรากอยู่ใน environment/Secret Manager แยกจาก backup (ADR-004)
- หมุนกุญแจ = มี downtime เล็กน้อยของ link ที่ค้างใน outbox (ดู §3) — ต้องมี runbook ใน T-118
- `security-reviewer` ตรวจก่อนปิด T-116 (ประเด็นเฉพาะ: ไม่มี plaintext ใน log/audit/response, AAD binding, ลำดับ env > DB, สิทธิ์ `integration.manage` เฉพาะ head, error ของ `rotate` ไม่ echo ค่า)
- T-116b (tester ต่อ adapter) และ T-116c (หน้า admin §12) ต่อจากสัญญานี้ได้ทันที: schema ของ response อยู่ใน `packages/shared`
- `[ASSUMED]`: catalog ของ integration/field (ชื่อและ required), trim + จำกัด 16 384 ตัวอักษร, รองรับ KEK ก่อนหน้าหนึ่งตัวเท่านั้น, ไม่มี rate limit เพิ่มบน `test` (mock ไม่มี network)

## Links
- ADR-004 · ADR-005 (audit) · ADR-006 (outbox, `secret-box`) · ADR-007 (`PORTAL_TOKEN_SECRET`)
- PRD §2.2, §4.12, §6.7, §7 · `docs/06-UI-SPEC.md` §12 · `docs/09-SECURITY.md` §1 · `docs/plans/phase-1-breakdown.md` §D T-116, §G ข้อ 10
