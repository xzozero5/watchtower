# Less text + AI assistant (T-133) — design direction

> Feedback เจ้าของ 2026-11-02: text ยังเยอะ · theme เป็น moon/sun · ภาษาเป็นธง · ทุก role สั่ง AI แทนการคลิกได้ · brief/สรุปการสืบค้นมาจาก AI แล้วคนกดลิงก์ดูหลักฐานจริง · staff ต้องเปิด ticket เองได้
> ต่อยอด `friendly-polish.md` + `ai-first-workspace.md` (layout เดิม) · ส่วนที่ขัดกับ `06-UI-SPEC.md` ให้เอกสารนี้ชนะ · ทุกข้อเป็น `[ASSUMED]` จนกว่าเจ้าของเห็นภาพ ยกเว้นที่อ้างโค้ด
> Implement โดย `frontend-dev` · `backend-dev`/`ai-engineer` สำหรับ §6

## 1. Declutter

### 1.1 Text → icon เมื่อไร
| ใช้ icon + tooltip + accessible name | คงคำไว้ |
|---|---|
| action ที่ใช้บ่อย ย้อนกลับได้ และอยู่ตำแหน่งเดิมเสมอ | สิ่งเสี่ยง/ย้อนกลับไม่ได้/ถึงลูกค้า (Send, Approve, switch ฉุกเฉิน, Sign out) |
| icon ที่เข้าใจทั่วไป (copy, filter, close, refresh) | severity: icon + label + สีเสมอ (PRD §10) |
| คำอธิบายใต้ field/หน้า → `CircleHelp` เปิด `Popover` (hover, focus, tap) | ป้าย N5: `AI`, `Uncited`, `Demo`, stage |
| label ของค่าที่อ่านออกเอง (pill, avatar) | error, empty state (บรรทัดเดียว), เหตุผลที่ปุ่มกดไม่ได้, หัวตาราง, label ของ form |

จอสัมผัสไม่มี hover: primary action บนมือถือคงคำ 1–2 คำเสมอ · ชื่อ accessible เป็น i18n key ทั้ง TH/EN · tooltip เปิดด้วย focus ได้ กด Esc ปิดได้ (WCAG 1.4.13)

### 1.2 Theme: moon/sun switch — ตัดสินใจ: สองสถานะ + default ตามระบบ
- เปิดใช้ครั้งแรก = `system` (ค่าเดิม `DEFAULT_THEME_PREFERENCE`) · switch แสดงธีมที่มีผลจริง · กดครั้งแรกแล้วเก็บ `light`/`dark`
- ไม่ทำ cycle สามสถานะ: บางครั้งกดแล้วหน้าจอไม่เปลี่ยน (system → light ตอนระบบสว่างอยู่แล้ว) ดูเหมือนเสีย
- กลับไปตามระบบ: `Follow system` ใน user menu อย่างเดียว
- `role="switch"`, `aria-checked` = มืด, ชื่อ "ธีมมืด" / "Dark theme" (ใน menu ใช้ `DropdownMenuCheckboxItem` เพราะ `switch` ซ้อนใน `menu` ไม่ถูก ARIA) · รางมีทั้งสอง icon และ knob จึงไม่ได้สื่อด้วยสีอย่างเดียว · reduced motion ไม่ slide

### 1.3 ภาษา: ธง — สองปุ่มคู่กัน ไม่ใช่ปุ่มเดียว
ธงเดี่ยวกำกวม (ภาษาปัจจุบัน หรือภาษาที่จะเปลี่ยนไป) จึงแสดงทั้งคู่เป็น radio group · ตัวที่เลือกมี ring 2 px + `aria-checked` ไม่หรี่อีกตัว
- **SVG inline** ใน `FlagIcon` (`packages/ui`) ขนาด 20×14 วาดเอง ไม่เพิ่ม dependency: Windows ไม่ render flag emoji
- ธงไม่ใช่ภาษา แต่ใช้ตามคำขอเจ้าของ: SVG เป็น `aria-hidden`, ชื่อ accessible คือชื่อภาษาในภาษานั้น (`ภาษาไทย` `lang="th"`, `English` `lang="en"`), tooltip เหมือนกัน · EN ใช้ธง GB `[ASSUMED]`
- ธงมี hairline ring (แถบขาวบนพื้นสว่าง) · แถบแดงในธงเป็นข้อยกเว้นเดียวของ "แดง = P1" เพราะเป็นภาพ ไม่ใช่สถานะ

### 1.4 หน้าต่อหน้า
| หน้า | เปลี่ยน |
|---|---|
| Login | เลิก `PreferencesControls` (select 3 ตัว + checkbox) → switch + ธงที่มุม · density/single-key ไม่ต้องมีก่อน sign in · รวมเป็นการ์ดเดียว: ปุ่ม SSO → เส้นคั่น → email + `Mail` · ตัด `login.dev.description` · dev login มีชิป `Dev` · break-glass ยังพับ |
| Rail | เพิ่ม `Plus` New ticket บนสุด (`ticket.create`) · ลบ `Keyboard` (ซ้ำกับ user menu) · รวม `LiveStatus` + `ApiStatus` เป็นจุดเดียว แสดงรายละเอียดใน tooltip เฉพาะเมื่อผิดปกติ · Brief/Handoff รวมใต้ `Clock3` Shift (ยังมี `g b`, `g h`) · ปรับให้ Kbd อยู่ใน tooltip ตอน expanded ด้วย |
| User menu | เลิก submenu 3 ชั้น → แถวบน: switch + ธงสองปุ่ม · density เป็น `SegmentedControl` icon สองตัว · ย้าย single-key ไปไว้ใน dialog keymap · `Sign out` คงคำ |
| Queue | intent chip เป็นชื่อแปลแล้ว (§5) · filter/bulk เป็น icon · หัว section เหลือ icon + จำนวน · empty state มีปุ่ม `Plus` New ticket |
| Ticket | ตัดหัวข้อ "What's happening" เหลือประโยคสรุป · evidence เป็นชิป (§4) · provenance ย่อเป็น `Bot` + อายุ (prompt version ใน tooltip) · stage badge สั้นลงแต่ยังเห็น |
| Admin | ประโยคยาว → `Popover`: Queues `onlyOnShift`, Integrations คำอธิบายหัวหน้า (`Encrypted` ชิป + `Lock`; `Mock` ชิปแทนประโยค "built-in fake"), AI controls เหลือผลกระทบ 1 บรรทัด ใต้สวิตช์ (ระบุสามหน้านี้จาก i18n ยังไม่เห็นภาพจริง `[ASSUMED]`) · row action อยู่ใน `⋯` |
| Shift | ชิปเหลือ `Clock3` + `3h 12m` (ที่เหลือใน tooltip) · ack `3/7` + bar · handoff: `AI` ชิปต่อ field + คำเตือนบรรทัดเดียวบนหน้า · เหตุผล clock out ไม่ได้ยังคงคำ |
| Portal | ป้าย "Language" + select → ธง + switch · หมวดเป็น icon + คำ · confirmation: key ใหญ่ + `Copy` · ลูกค้าไม่เห็น stage/confidence |

## 2. AI assistant bubble
ต่อยอด Personal Assistant (PRD §6.2) ซึ่งกำหนดไว้แค่ head/lead/agent · ใช้คนละหน้าที่กับ pane "Details & AI": pane = ticket นี้, bubble = สั่งงาน/ถามได้จากทุกหน้า

### 2.1 ตำแหน่งและรูปแบบ
| ความกว้าง | Collapsed | Expanded |
|---|---|---|
| ≥ 1280 | ปุ่มกลม 48 px, ขวาล่าง ห่าง 16 px | การ์ด 400 px วางทับ pane ขวา (ส่วนกลางและ composer ไม่ถูกบัง) |
| 768–1279 | เหมือนกัน | ชิดขวาแบบ drawer เดิม; เปิดแล้วปิด detail drawer |
| < 768 | 44 px เหนือ A/E/R bar + safe area | `Sheet` เต็มจอ |

- **ไม่บัง:** scroll container เว้นท้าย 72 px · sticky footer (handoff, sheet) ดัน bubble ขึ้นตามความสูงที่วัดได้ · จอ < 1024 ซ่อนระหว่าง focus ใน composer · ซ่อนเมื่อมี modal · ความสูง expanded ไม่เกินจอลบ P1 banner · toast อยู่ `bottom-left` อยู่แล้ว (`toaster.tsx:33`; §8.1 ของ UI spec ที่ว่า top-right ไม่ตรงกับโค้ด)
- **เงียบ:** พื้น `surface-raised` + icon `Bot` สี `ai-accent` · ไม่กะพริบ ไม่เด้ง ไม่มีเสียง ไม่เปิดเอง ไม่มีข้อความเชิญชวน · จุด teal เฉพาะเมื่องานที่คนสั่งเองเสร็จ · ปิด bubble ได้ใน user menu (`Ctrl/⌘ J` ยังใช้ได้)
- Portal สาธารณะที่ไม่ sign in: **ไม่มี bubble** (กัน LLM cost จากคนนิรนาม)

### 2.2 Keyboard
| Key | ผล |
|---|---|
| `Ctrl/⌘ J` | เปิด + focus ช่องพิมพ์ / ปิด (ทำงานใน text field ด้วย; ทับ Downloads ของ browser `[VERIFY]` Chrome/Edge/Firefox) + palette command |
| `Enter` / `Shift Enter` | ส่ง / ขึ้นบรรทัด — `Enter` ไม่เคยยืนยัน action card |
| `Tab` | วนใน panel (soft trap) · มือถือเป็น modal trap จริง |
| `F6` | ออกจาก panel ไป pane ถัดไปโดยไม่ปิด (ทำให้ desktop ไม่เป็น keyboard trap; WCAG 2.1.2 และกดลิงก์หลักฐานแล้วอ่านคู่กันได้) |
| `Esc` | ยกเลิก confirm ที่เปิดอยู่ → ไม่มีแล้วก็ collapse, focus กลับปุ่ม, ข้อความที่พิมพ์ยังอยู่ |

### 2.3 Context chips
เหนือช่องพิมพ์ แสดงสิ่งที่ส่งให้ AI: `Queue`, `OPS-1234` · กด `×` เอาออก = ไม่ส่ง · เปลี่ยนหน้าแล้วอัปเดต · ไม่มีเดาบริบทลับ

### 2.4 Starter prompts (สูงสุด 3 ชิป แสดงเมื่อ thread ว่าง และตัด chip ที่ขาดสิทธิ์ทิ้ง)
| Role | TH | EN |
|---|---|---|
| agent | สรุปเรื่องนี้ · หาเคสคล้ายกัน · ร่างคำตอบ | Summarize this · Find similar · Draft a reply |
| lead | อะไรเสี่ยง SLA · ใครงานล้น · ร่าง handoff | SLA at risk · Who's overloaded · Draft handoff |
| head | สรุปวันนี้ · AI เป็นยังไงบ้าง · ลูกค้าไหนน่าห่วง | Today's summary · How's AI doing · Accounts at risk |
| dev | งานถัดไปของฉัน · สรุปหลักฐาน · deploy ไหนเกี่ยว | My next ticket · Sum up evidence · Related deploys |
| client | เรื่องของฉันถึงไหน · เปิดเรื่องใหม่ · หาคู่มือ | My requests · New request · Find a guide |

**Client `[ASK-HUMAN]`:** ลูกค้าให้ AI ตอบเป็นประโยคเอง = AI ตอบลูกค้า ซึ่ง N3 อนุญาตเฉพาะ stage ≥ 3 และ PRD §1.2 ตัด chat widget ออก · default ที่เสนอ: bubble ของ client **ไม่สร้างคำตอบ** ทำแค่แสดงสถานะ ticket ขององค์กรตัวเอง, ลิสต์บทความ KB ที่ publish แล้ว (`kb.read.customer`), เติมฟอร์มเปิด ticket · ถ้าจะมากกว่านี้ต้องแก้ PRD/ADR

### 2.5 ผลลัพธ์
- **คำตอบ:** bullet ไม่เกิน 5 ข้อ ใช้รูปแบบ claim + ลิงก์ (§4) ภาษาตาม locale ผู้ใช้ · ลิงก์ในแอปเปลี่ยนหน้าโดย panel เปิดค้าง · แถบ `tools` พับไว้ (ชื่อ, ok/error/denied, mock) · `Copy`, `Stop`
- **Action card (write, N2):** ระบุสิ่งที่จะทำ + เป้าหมาย + ก่อน → หลัง · กดปุ่มเดียวไม่มี dialog ซ้อน · focus ไม่กระโดดไปที่ปุ่ม กันกด `Enter` พลาด · รันด้วยสิทธิ์ของคนนั้น server ตรวจซ้ำตอนกด · ticket เปลี่ยนแล้วการ์ดหมดอายุ · ลง audit (`via=assistant`) · มี undo toast เมื่อย้อนกลับได้
- **ถึงลูกค้า (N3):** bubble ไม่มีปุ่ม Send · "ร่างคำตอบ" เปิด Draft card A/E/R เดิม ซึ่งมี policy gate + undo
- **ไม่มี action card:** switch ฉุกเฉิน, autonomy, role, integration, bulk ที่ส่งถึงลูกค้า → ลิงก์ไปหน้านั้นเท่านั้น
- ข้อความลูกค้า/KB ที่ AI อ่านเป็นข้อมูล ไม่ใช่คำสั่ง: redact ก่อนส่ง (N4), ทุกครั้งลง `ai_run`

### 2.6 States
| State | แสดง | TH / EN |
|---|---|---|
| Thinking | `aria-busy`, ข้อความนิ่ง, `Stop` | กำลังคิด / Thinking |
| Tool running | ชื่อขั้นตอน + bar แบบ `Progress` ใน `ai-brief.tsx` | กำลังค้น KB · 2/3 / Searching KB · 2/3 |
| ไม่มีหลักฐาน | §4 | ไม่พบหลักฐาน / No evidence found |
| ติดงบ | ปิดช่องพิมพ์, ลิงก์ AI controls เฉพาะ lead/head | งบ AI หมดแล้ววันนี้ ทำงานเองได้ตามปกติ / AI budget used up today. Everything else still works. |
| AI paused (`ai_kill_switch`) | icon `PauseCircle` บนปุ่ม, ปิดช่องพิมพ์ | AI หยุดชั่วคราว / AI is paused |
| ไม่มีสิทธิ์ | อธิบาย ไม่มี action card | คุณไม่มีสิทธิ์นี้ / You don't have access |
| Error / offline | `RefreshCw` Retry, ข้อความยังอยู่ | ลองใหม่อีกครั้ง / Try again |

### 2.7 A11y
Panel เป็น `role="dialog"` มีชื่อ · thread เป็น `log` polite ประกาศ "คำตอบพร้อม" ไม่ใช่ทีละ token · ปุ่ม `aria-expanded`, `aria-keyshortcuts` · 320 px / zoom 200% เป็น `Sheet` เต็มจอ

## 3. สร้าง ticket: `/tickets/new`
`POST /v1/tickets` มีอยู่แล้ว (`ticket.create`) แต่ `apps/web` ยังไม่มีหน้า/client เรียก · เข้าจาก rail `Plus`, palette, bubble, `Shift C`

| Field | กติกา |
|---|---|
| **วางข้อความ** (บนสุด, ไม่บังคับ) | วาง email/แชต → `Bot` เติมให้ · redact ก่อนส่ง · ค่าจาก AI มีชิป `AI` จนกว่าจะแก้ · ไม่แน่ใจ = เว้นว่าง · ไม่สร้างเอง · AI paused/ติดงบ = ซ่อนส่วนนี้ ฟอร์มยังใช้ได้ |
| Org* | `Combobox` · ไม่จำค่าล่าสุด กันเลือกผิดองค์กร |
| Requester* | `Combobox` contact หรือ email + ชื่อใหม่ (ตรงกับ schema) |
| Subject*, Body* | Body เขียน "เหมือนลูกค้าเขียน" (schema) · ระบุชัดว่า**ไม่ได้ส่งถึงลูกค้า** |
| Priority, Intent, Queue, Assignee | พับใต้ `More` · AI เสนอได้ · ไม่ระบุใช้กฎเดิม |

- Keyboard: `Ctrl/⌘ Enter` สร้าง · `Esc` กลับ (เตือนเมื่อมีข้อความ, draft อยู่ใน session) · error summary + `aria-describedby`
- **ซ้ำ:** แสดงแถบ non-blocking ทางขวาเมื่อมี Org + Subject: `OPS-1234` + สถานะ + `Open` · ห้ามบล็อกการสร้าง · ไม่มีผลก็ไม่แสดงแถบ
- สำเร็จ: ไปที่ ticket + toast พร้อม key · client ใช้ฟอร์ม portal เดิม (`portal/submit-form.tsx`)

## 4. AI summaries: claim + ลิงก์หลักฐานจริง

**รูปแบบเดียวทุกที่ (`ClaimLine`):** 1 บรรทัด = 1 claim + ชิปลิงก์ (`EVIDENCE_ICONS`) ไปของจริง · ไม่มีหลักฐาน = `Uncited` · ไม่มี `href` = ชิปเปิด snippet + บอก "ไม่มีลิงก์"

| Surface | AI เขียน | ลิงก์ไป | ไม่มีหลักฐาน |
|---|---|---|---|
| Daily brief | สรุปต่อ section (มี `brief.aiSummary`) | ticket, incident, note | section ยุบ 1 บรรทัด, ไม่สรุปลอย |
| Handoff | เติมทุก field, คนตรวจแล้วกดยืนยัน | ticket, alert, deploy | เว้นว่าง + ให้คนเขียน (next action ยังบังคับตาม AC-7) |
| Ticket brief | สรุป, intent, next step | evidence panel → ต้นทาง | "ยังไม่พบหลักฐาน" + `Investigate` |
| Investigation | `findings[].evidenceIds`, `openQuestions` | log query, KB, repo | แสดง tool ที่ denied/error เป็นช่องว่างที่รู้ตัว ไม่เดาสาเหตุ |

### Confidence (N5)
| ที่มา | แสดง |
|---|---|
| mock (`AI_PROVIDER`/`EMBEDDING_PROVIDER=mock`, `tools[].mock`) | ชิป `Demo` slate · **ไม่มีตัวเลข ไม่มี dots** |
| คะแนน retrieval | คำว่า "ตรงมาก/พอใช้/น้อย" (`Strong/Fair/Weak match`) ไม่ใช่ confidence · เลขใน tooltip · `≥ 0.995` แสดง `> 0.99` ไม่เคย `1.00` |
| ความมั่นใจของ model | `ConfidenceDots` + คำ · เลขใน tooltip + "ยังไม่ calibrate" จนมี eval (T-302) |

### Defect ที่ต้องแก้
| Defect | ต้นเหตุ | แก้ |
|---|---|---|
| ภาษาอังกฤษปนในไทย | `dev-mock.ts:140,220` เลือกภาษาจากเนื้อ ticket; `nextStep.label`, `intent.reason` เป็น prose | ปุ่ม next step ใช้ i18n จาก `kind` · การวิเคราะห์ใช้ภาษาผู้ดู (ส่ง locale ให้ AI) · **draft ลูกค้าคงภาษาลูกค้า** · ข้อความที่ภาษาไม่ตรงใส่ `lang` + ชิปภาษา |
| Markdown ดิบ | `evidence-panel.tsx:84` แสดง `snippet` ตรง ๆ | producer ตัด markdown เป็น plain text · clamp 3 บรรทัด · ห้าม `dangerouslySetInnerHTML` · test `##`, `**`, ลิงก์ |
| `1.00` | `evidence-panel.tsx:78–81` พิมพ์ band + เลขเสมอ | ตารางบน |
| `billing_report` | `ai-brief.tsx:287` `name={intent.key}` | API ส่ง `intent.name` ตามภาษา · fallback: ตัด `_` เป็นคำ, key อยู่ใน tooltip ของ lead/head |

## 5. Role `dev`
**ยังไม่มีใน `ROLES`/`STAFF_ROLES` (`rbac.ts:12,16`) และไม่อยู่ใน PRD** → ต้องมี ADR + migration ก่อน (N10) · สิทธิ์ที่เสนอ: `ticket.read`, `ticket.handle`, `investigate.run`, `kb.read`, `auth.session.self` · **ไม่มี** `ticket.reply`, `ai.draft.review` · ควรให้ dev เห็น PII ลูกค้าแค่ไหน `[ASK-HUMAN]` (เสนอ mask โดย default)

| จุด | Spec |
|---|---|
| Rail | Dev queue, Notifications, New ticket เท่านั้น |
| `/dev` | reuse queue board · กลุ่ม `รอรับ` / `ของฉัน` / `ส่งคืนแล้ว` · แถว: AI summary, priority, อายุตั้งแต่ส่งมา, service · `j/k`, `Enter` |
| ส่งให้ dev (agent) | next step `escalate_dev` เดิม → dialog มีคำถาม + หลักฐาน + สิ่งที่ลองแล้ว (AI เติม, คนกดส่ง) |
| ticket มุม dev | การ์ดคำถาม → brief → หลักฐาน · ไม่มี composer ถึงลูกค้า ไม่มี A/E/R มีแค่ internal note |
| Pick up | `I` แล้ว `Enter` / ปุ่ม `Pick up` → เจ้าของ support เดิมยังอยู่ · คนอื่นรับไปแล้ว → ชื่อ + รีเฟรชแถว |
| Status | `รอรับ → กำลังตรวจ → กำลังแก้ → ส่งคืน` เป็น sub-status · `Return` บังคับ finding 1 บรรทัด (AI เติมได้) → ticket กลับ `open` + แจ้ง agent |
| "Waiting on dev" (agent/lead) | ชิป `CodeXml` + อายุ + avatar dev · client ยังเห็น "In progress" (`status-label.test.tsx:43`) · แถวยังอยู่กลุ่ม Waiting |
| แจ้งเตือน | ตาม §8.1: P1/P2 เท่านั้นที่ขัดจังหวะ · ที่เหลือเป็น badge |

## 6. สิ่งที่ต้องเพิ่มและ reuse (N6, ตรวจ `packages/ui/src` + `apps/web/src/components`)
| Reuse | สร้างใหม่ (`packages/ui`) | สร้างใหม่ (`apps/web`) | Backend |
|---|---|---|---|
| `IconButton`, `Tooltip`, `Popover`, `Sheet`, `Dialog`, `Combobox`, `Field`, `SegmentedControl`, `TintChip`, `ConfidenceDots`, `IntentChip`, `EmptyState`, `EVIDENCE_ICONS`, `CommandPalette`, Draft card A/E/R, queue board | `ThemeSwitch`, `LanguageFlags`, `FlagIcon` | `AssistantBubble`, `AssistantPanel`, `ActionCard`, `ClaimLine`, `NewTicketPage`, `DevQueuePage` | assistant endpoint + action schema · role `dev` + `dev_assignee`/sub-status · prefill และ similar ก่อนสร้าง (`duplicates` ปัจจุบันต้องมี ticket + intent แล้ว) · `intent.name` · `mock` และชนิดคะแนนใน `aiEvidenceSchema` · สถานะงบ AI ไปยัง web · เพดาน per-user ใน `budgets.yaml` |

## 7. Contrast / a11y ที่เพิ่ม
- [ ] คู่สีใหม่ทุกคู่ (bubble, ราง switch, ชิป `Demo`, ring ธง) อยู่ใน `contrast.test.ts` ทั้ง light/dark: 4.5:1 text, 3:1 icon/UI
- [ ] Grayscale ยังแยก theme, ภาษาที่เลือก, AI paused, `Uncited`, `Demo` ออก
- [ ] Target ≥ 24 px desktop, ≥ 44 px มือถือ · focus ring 2 px ทุกตัว · ไม่กะพริบ · respect reduced motion
- [ ] axe ผ่านในสถานะ bubble ปิด/เปิด + บน `/tickets/new`, `/dev`
- [ ] ทุก icon-only มี tooltip + ชื่อ TH/EN, ทุก shortcut ใหม่อยู่ใน keymap/palette, single-letter ปิดได้ (WCAG 2.1.4)

## 7.1 แก้ไข 2026-11-02 (po ตัดสินแทนเจ้าของ, QA-08 จาก role-play)
ปุ่มที่เป็นจุดตัดสินใจต้องมี **label สั้นคู่ไอคอน**: ใน AI card (Approve/Send, Edit, Regenerate, Send to dev), composer (Reply / Note) และแท็บของ right pane · ปุ่ม chrome รอง (theme, ภาษา, rail, close, copy) ยังเป็นไอคอน + tooltip + ชื่อที่ screen reader อ่านได้ · แท็บ default ของ right pane ต้องคงที่ ไม่เปลี่ยนตามสถานะของ AI · สีใช้บอกสถานะเท่านั้น: rail เป็นสีกลาง ๆ เว้นหน้าปัจจุบันหรือมี count > 0, ค่า 0 ไม่แดง (QA-20) · เหตุผล: ผู้ใช้ 2 บทบาทสับสน "Send to dev + ดินสอ" อ่านเป็น "แก้ข้อความ" และการกดผิดที่จุดตัดสินใจมีต้นทุนจริง

## 8. ค้างให้คนตัดสิน `[ASK-HUMAN]`
1. Client ให้ AI ตอบเป็นประโยคได้หรือไม่ (§2.4; N3, PRD §1.2) 2. เปิด role `dev` + ระดับ PII (§5)
