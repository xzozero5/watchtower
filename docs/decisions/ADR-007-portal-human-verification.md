# ADR-007 — Human verification ของ client portal แบบ self-hosted (T-007)

- **Status:** Accepted 2026-11-01 · ตรวจโดย `security-reviewer` T-010 (2026-11-01) หลังแก้ C-3, C-4 · ค้าง P3 C-17 (replay ของ proof ที่ claim แล้วกิน bucket) → T-125
- **Date:** 2026-11-01 (เวลากรุงเทพ) · **ผู้ตัดสิน:** `po` ตามอำนาจที่เจ้าของมอบ (HANDOFF "PO ตัดสินแทนเจ้าของ" #22 `[ASSUMED]` รอเจ้าของทบทวน)
- **Context:** PRD R-9.1 ให้หน้า submit สาธารณะมี human verification โดยยกตัวอย่าง Turnstile/hCaptcha · ทั้งสองคือบริการภายนอก: ต้องโหลด script จาก vendor, ส่ง IP/fingerprint ของผู้ใช้ไปให้ vendor และเพิ่มปลายทาง network ใหม่ของ server (`siteverify`) ซึ่ง AGENTS.md ให้หยุดถามเจ้าของ (`[ASK-HUMAN]`) · `po` ตัดสินให้ทำแบบ self-hosted ก่อน (UI spec §10, §17 Q5) · endpoint สาธารณะ 2 ตัว (`GET /v1/portal/challenge`, `POST /v1/portal/tickets`) ไม่มี session จึงต้องกันบอท, การสแปมกล่องอีเมลของคนอื่น (confirmation ไปที่อีเมลที่ผู้ส่งพิมพ์เอง) และการเติม ticket ปลอม · ข้อจำกัด: ห้ามเพิ่ม dependency (N10/AGENTS.md), ห้าม PII/secret ใน log (N1), ทุก mutation ลง audit (PRD §8.2)

## Decision

**ทำ human verification เองในสามชั้น แล้วซ่อนไว้หลัง interface `HumanVerificationProvider` ตัวเดียว**

```ts
interface HumanVerificationProvider {
  readonly name: string; // 'pow-sha256' วันนี้
  challenge(): Promise<HumanChallenge>; // สิ่งที่หน้า web ต้องแก้ (GET /v1/portal/challenge)
  verify(submission, context): Promise<VerificationResult>; // ok | reason (audit ได้)
}
```

1. **Proof-of-work (SHA-256, leading zero bits)** — ใช้ `node:crypto` ฝั่ง server, WebCrypto ใน Web Worker ฝั่ง browser, ไม่มี dependency เพิ่ม
   - `GET /v1/portal/challenge` ออก challenge แบบ **stateless** ที่ server เซ็น: `id.exp.issuedAt.difficulty.sig` โดย `sig = HMAC-SHA256(key, "pow1|id|exp|issuedAt|difficulty")` (id สุ่ม 128 bit, key derive ด้วย HKDF จาก `PORTAL_TOKEN_SECRET` หรือ `APP_ENCRYPTION_KEY` พร้อม label แยกต่อวัตถุประสงค์) · ไม่เขียน Redis ตอนออก จึงไม่มีทางเปิดช่องให้ flood หน่วยความจำ
   - client หา `nonce` (สตริง) ที่ `SHA-256(utf8("<challenge>:<nonce>"))` มี leading zero bits ≥ `difficulty` · ค่าเริ่มต้น 18 bits (≈ 262k hash เฉลี่ย, ราว 1–3 วินาทีบนมือถือ) ปรับด้วย `PORTAL_POW_DIFFICULTY_BITS` `[ASSUMED]`
   - server ตรวจ: รูปแบบ → HMAC (timing-safe) → ยังไม่หมดอายุ (ค่าเริ่มต้น 30 นาที) → bits → **ใช้ได้ครั้งเดียว**: `SET wt:portal:pow:<id> NX EX <ttl ที่เหลือ + slack>` ใน Redis · ถ้า key มีอยู่แล้ว = replay → ปฏิเสธ · ใช้ difficulty ที่อยู่ในส่วนที่เซ็นเท่านั้น (client เลือกเองไม่ได้)
   - Redis ล่ม = fail closed (500/503) ไม่ปล่อยผ่าน
2. **Honeypot + minimum fill time**
   - ฟิลด์ล่อ `website` ต้องว่าง (ซ่อนด้วย CSS + `aria-hidden` + `tabindex=-1` + `autocomplete=off`) · ถ้ามีค่า = บอท
   - เวลาขั้นต่ำระหว่าง `issuedAt` ของ challenge กับตอน submit (ค่าเริ่มต้น 3 วินาที `PORTAL_MIN_FILL_SECONDS`) · web ต้องขอ challenge ตอนเปิดฟอร์ม ไม่ใช่ตอนกดส่ง · เร็วกว่านี้ = ปฏิเสธ (ไม่ burn challenge: รอแล้วส่งซ้ำด้วย challenge เดิมได้)
3. **Rate limit ใน Redis** (fixed window ต่อชั่วโมง, key เป็น SHA-256 ของ subject ไม่เก็บ IP/อีเมลตรง ๆ — ใช้ `RateLimiter` เดิมของ T-004)
   - ต่อ IP (ค่าเริ่มต้น 20/ชม.), ต่อ email (5/ชม., กันการถล่มกล่องของเหยื่อ), ต่อ org (60/ชม.; ถ้า org ยังไม่ตรง allow-list ใช้โดเมนของอีเมลแทน เพื่อไม่ให้ผู้ส่งแปลกหน้าแย่ง bucket เดียวกันหมด) · ตอบ `429` + `Retry-After` · **ทุกครั้งที่ปฏิเสธลง audit** (`portal.rate_limited`, outcome `denied`, metadata บอกว่า scope ไหน ไม่มี IP/อีเมลดิบใน metadata — `audit_log.ip` ตามปกติ)
   - read/reply ผ่าน tracking link มี limit แยก (ต่อ IP และต่อ ticket)
   - ลำดับตรวจ (แก้ตาม T-010 C-3): validate body → **limit ต่อ IP** → **ตรวจ proof แบบ stateless** (รูปแบบ, HMAC, หมดอายุ, เวลากรอก, honeypot, PoW — ไม่แตะ Redis/DB) → **limit ต่อ email และต่อ org** → **claim challenge (ใช้ครั้งเดียว)** → สร้าง ticket · เหตุผล: ใครไม่ได้ทำ PoW ก็ใช้โควตา email/org ของคนอื่นไม่ได้ (เดิม script ส่งอีเมลเหยื่อซ้ำ ๆ จนโควตา 5/ชม. หมดโดยไม่ต้องแก้ PoW เลย) · request ที่ถูก limit ปฏิเสธไม่ burn proof ที่ผู้ใช้เสียแรงทำไปแล้ว ส่งซ้ำด้วย proof เดิมได้ · `HumanVerificationProvider` จึงแยกเป็น `check()` (stateless) กับ `claim()` · ข้อจำกัดที่ยอมรับ `[ASSUMED]`: proof ที่ถูก claim แล้วถูก replay ผ่าน `check` และใช้โควตา email/org ได้อีกครั้งละ 1 ก่อนถูก `claim` ปฏิเสธ — จำกัดด้วย limit ต่อ IP (20/ชม.) และต้องมี PoW ที่ถูกต้องอย่างน้อย 1 ครั้ง

**ผู้ให้บริการภายนอก (Turnstile/hCaptcha) = `[ASK-HUMAN]`** — เพิ่มได้ภายหลังโดยเขียน class ใหม่ที่ implement `HumanVerificationProvider` แล้วสลับที่ DI token `HUMAN_VERIFICATION` โดยไม่แตะ controller/service · มันคือปลายทาง network ใหม่ (script ฝั่ง browser + `siteverify` ฝั่ง server) และส่ง IP ผู้ใช้ให้ vendor ต้องให้เจ้าของอนุมัติและเขียน ADR ใหม่ (Supersedes ฉบับนี้ในส่วนที่เกี่ยว) · contract ของ `challenge` เป็น discriminated union บน `provider` เพื่อให้ web รองรับหลายแบบได้

**ไม่มี "mock mode" ที่ผ่านเสมอ** — `docs/04-ARCHITECTURE.md` §6 เคยร่างว่า human verification ผ่านเสมอใน mock · เมื่อทำ self-hosted ไม่มีปลายทางภายนอกให้ mock แล้ว จึงใช้ difficulty ต่ำ (`PORTAL_POW_DIFFICULTY_BITS=8`) กับ `PORTAL_MIN_FILL_SECONDS=0` ใน test/e2e แทน ไม่มีสวิตช์ปิดการตรวจที่อาจหลุดขึ้น production

## Options considered

- **A — Turnstile/hCaptcha ตั้งแต่ต้น** — กันบอทดีที่สุดและผู้ใช้ไม่ต้องรอ PoW · แต่ปลายทาง network ใหม่ + ส่ง IP ให้ vendor (PDPA/N1) และต้องมี credential จริง → `[ASK-HUMAN]` ไม่อยู่ในอำนาจ `po`
- **B (เลือก) — PoW + honeypot + rate limit self-hosted หลัง interface** — ไม่มีปลายทางใหม่, ไม่มี dependency, ทดสอบอัตโนมัติได้ครบ · แลกกับกันบอทที่มี GPU/แรงเยอะไม่ได้ และผู้ใช้รอ 1–3 วินาที
- **C — rate limit อย่างเดียว** — ง่ายสุด แต่ไม่เพิ่มต้นทุนต่อคำขอให้บอท
- **D — ให้ email ยืนยันก่อนสร้าง ticket (double opt-in)** — กัน email ปลอมได้จริง แต่เพิ่ม friction ทุกครั้งและ AC-1 ต้องการ ticket ภายใน 10 วินาที · เก็บไว้เป็นทางเลือกถ้าพบการใช้ในทางที่ผิด

## Consequences

- **CSRF ของ endpoint สาธารณะ:** portal ไม่ใช้ cookie เลย — submit ไม่ต้อง auth, ส่วน tracking ใช้ header `X-Portal-Token` ที่ web ใส่เอง (ไม่ใช่ credential ที่ browser แนบอัตโนมัติ) จึงไม่มี ambient authority ให้ CSRF โจมตี · `originCheck` เดิมยังบล็อก `Origin` แปลกปลอมบน POST · CORS allow-list ยังเป็น `APP_URL` เดียว (เพิ่มเฉพาะ header `x-portal-token`) `[ASSUMED]`
- ความเสี่ยงที่ยอมรับ: ใครก็ส่งฟอร์มโดยใช้อีเมลของคนอื่นได้ (ผู้รับจะได้อีเมล confirmation 1 ฉบับต่อ ticket สูงสุด 5 ฉบับ/ชม.) · tracking link ส่งทางอีเมลเท่านั้น ไม่คืนใน response ผู้ส่งจึงไม่ได้สิทธิ์อ่าน ticket ของคนอื่น
- **อีเมลที่ไม่ได้ยืนยัน (T-010 C-4, C-11, C-13) `[ASSUMED]`:**
  - ที่อยู่อีเมลของผู้ส่งฟอร์มไม่เคยถูกพิสูจน์ (ไม่มี double opt-in) ดังนั้น **urgency ที่เลือกถูกจำกัดไม่เกิน P2 กับทุก ticket ของ portal** (เดิมจำกัดเฉพาะ org ที่ยังไม่ match) · ticket ได้ `customFields.portal.requesterVerified = false` และ `urgencyCapped = true` เมื่อถูกลดจริง ให้ staff UI อ่านภายหลัง (ยังไม่มี flag นี้ใน UI) · staff ปรับ priority เองหลังอ่าน ticket · `requesterVerified` จะเป็น `true` ได้ก็ต่อเมื่อมีการพิสูจน์อีเมลจริง (เช่น เปิด tracking link ที่ส่งไปที่อีเมลนั้น หรือ double opt-in) ซึ่งยังไม่ทำ
  - **อีเมลที่ตอบกลับผู้ส่งฟอร์มไม่ echo ข้อความที่ผู้ส่งพิมพ์** (subject): confirmation และอีเมล "ลิงก์ใหม่" ไม่มี subject เพราะทั้งสองถูกกระตุ้นได้ด้วยการพิมพ์อีเมลของคนอื่น (ไม่งั้นระบบเราส่งข้อความฟิชชิงให้เหยื่อได้) · อีเมลที่ตามหลังการกระทำของ staff (ตอบกลับ, เปลี่ยนสถานะ, merge) ยังแสดง subject ของ ticket
  - **tracking link:** อายุเริ่มต้น 30 วัน (`PORTAL_TOKEN_TTL_DAYS`, เดิม 90) · เมื่อ ticket เป็น `closed` ทุก link ของ ticket ถูก revoke ใน transaction เดียวกับการเปลี่ยนสถานะ และอีเมลแจ้งปิดชี้ไปหน้า ticket ที่ไม่มี token (ผู้ร้องขอ link ใหม่ทางอีเมลได้ ซึ่งเป็นการพิสูจน์ว่าถือกล่องอีเมล) · อีเมลที่พก link มีอายุ 24 ชม. ใน outbox (ADR-006)
- difficulty คงที่ ยังไม่ปรับตามภาระ (adaptive) `[ASSUMED]` · ตรวจซ้ำถ้ามีบอทผ่าน หรือผู้ใช้มือถือรอนานเกินไป
- challenge ที่ verify ผ่านแล้วใช้ซ้ำไม่ได้ (ถ้า request ล้มเหลวหลังจากนั้น ต้องขอใหม่) · web ต้องขอ challenge ใหม่เมื่อได้ 400 `verification_failed` (ยกเว้นเหตุ `too_fast` ซึ่งรอแล้วส่งซ้ำได้) หรือ 429
- ถ้าเปลี่ยน `PORTAL_TOKEN_SECRET`/`APP_ENCRYPTION_KEY` challenge ที่ค้างอยู่ใช้ไม่ได้ (ปกติ ขอใหม่) และ tracking link ที่ส่งไปแล้วใช้ไม่ได้ทั้งหมด (ลูกค้าขอลิงก์ใหม่ด้วยอีเมล)
- ต้องตรวจซ้ำ: ก่อนเปิดลิงก์แยกต่อ org (R-9.1 "per org") · เมื่อเจ้าของตัดสินเรื่อง hosted provider · ตอน T-010 (`security-reviewer`)

## Links

- PRD §4.9 R-9.1–9.3, §8.2 · `docs/06-UI-SPEC.md` §10, §17 Q5/Q6 · HANDOFF "PO ตัดสินแทนเจ้าของ" #22 · BACKLOG T-007
- ADR-004 (ที่มาของกุญแจ), ADR-005 (rate limiter/audit/CSRF ของ staff), ADR-006 (outbox ที่ใช้ส่งอีเมล)
- โค้ด (ดูไฟล์จริงใน `apps/api/src/portal/`): `human-verification.ts`, `pow.ts`, `self-hosted-verification.ts`
