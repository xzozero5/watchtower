# Redesign proposal 2026-11 — "Soft Beacon"

> ข้อเสนอรอเจ้าของอนุมัติ ยังไม่ใช่ spec และยังไม่แตะ `apps/` หรือ `docs/06-UI-SPEC.md` · ทุกค่าในเอกสารนี้เป็น `[ASSUMED]` จนกว่าเจ้าของจะดูภาพแล้วตัดสิน
> แรงบันดาลใจ: Dribbble "UI/UX for Sales Command Center" (ไฟล์ภาพที่เจ้าของส่งมา) ใช้แค่ระดับ pattern ไม่ได้คัดลอก asset หรือโค้ด
> Mockup: `head-home.html`, `ticket-workspace.html` เปิดใน browser ได้เลย (โหลด Google Fonts ผ่าน network · ปุ่ม sun/moon สลับธีม · ลองย่อจอเหลือ 1024 ได้) · ข้อมูลทั้งหมดเป็นตัวอย่าง (`Example Co.`, `Acme Logistics`, ชื่อคนสมมติ)

## 1. เปลี่ยนอะไรเมื่อเทียบกับ UI ปัจจุบัน
| ด้าน | ตอนนี้ (`docs/screenshots/dashboard.jpg`, `ticket-ai-brief.jpg`) | ข้อเสนอ |
|---|---|---|
| โครงหน้า | แอปเต็มจอ, rail 56 px, แบ่ง pane ด้วย hairline | แอปเป็นแผ่นขาวมุมโค้ง 28 px ลอยบนพื้น gradient (navy-mist → seafoam → cream) · พื้นที่ทำงานสีเทาอ่อน `canvas` วางการ์ดขาว |
| Sidebar | icon rail อย่างเดียว | หน้า Overview: sidebar 248 px มีกลุ่ม Main / Inboxes / Other, inbox แต่ละช่องทางเป็นวงกลมสีพร้อม address + จำนวน, chip กะ, การ์ดผู้ใช้ · หน้า ticket: หุบเป็น rail 76 px (ต้องการพื้นที่ 3 pane) |
| Nav ที่เลือก | พื้นเทาอ่อน | pill gradient navy → deep teal ตัวอักษร ivory |
| Top bar | ไม่มี (T-124 ตัดออก) | กลับมาเฉพาะหน้าแบบ dashboard: search + `⌘ K`, avatar stack คนที่อยู่กะ, bell, theme switch, ปุ่มหลัก navy `New ticket` · หน้า ticket ยังไม่มี global top bar |
| หัวหน้า | 14 px/600 | ชื่อหน้า 34 px weight 300 + subtitle บรรทัดเดียว + ปุ่ม ghost (Refresh, Customize) |
| การ์ด | hairline, ไม่มีเงา | ไม่มีเส้นขอบ เงานุ่มมาก มุม 20 px · ปุ่มกรองเป็น pill เล็กมุมขวาบน |
| Dashboard | ตัวเลข + bar chart สีเดียว | hero metric + trend chip, stacked bar ตามช่องทางพร้อมคอลัมน์ไฮไลต์ลาย hatch + tooltip card, ตารางคิวหัวโค้ง + แถวที่เลือกยกขึ้น, gauge วงแหวน, การ์ดไฮไลต์ navy + แสงทอง beacon |
| Ticket | brief กลาง, evidence ขวา | brief ย่อกลาง (สรุป + intent + ปุ่ม `Review draft`) → timeline → composer · ขวา = คอลัมน์การ์ด AI: header + stage badge, investigation steps, evidence, **draft card A/E/R** |
| ตัวอักษร | Inter + Noto Sans Thai | Plus Jakarta Sans + IBM Plex Sans Thai (+ IBM Plex Mono สำหรับ key) |

## 2. Design tokens (ทั้งหมด `[ASSUMED]`)
ค่า severity, tint, avatar ใช้ของเดิมใน `packages/ui/src/tokens/colors.ts` ทั้งหมด ไม่แตะ · coral `#E5594A` อยู่ในโลโก้เท่านั้น

| Token | Light | Dark | ใช้ที่ |
|---|---|---|---|
| `backdrop` | radial `#D9E3F0` + `#CFEBE3` บน `#EDF1F6→#F5F3E9` | radial `#18233A` + `#0F2E2C` บน `#070B14→#0D1117` | พื้นหลังนอกแอป |
| `frame` | `#FFFFFF` | `#121722` | แผ่นแอป + sidebar |
| `canvas` | `#F4F6F8` | `#0E1219` | พื้นที่ทำงาน |
| `surface` / `surface-muted` | `#FFFFFF` / `#F1F3F6` | `#161B25` / `#1C2230` | การ์ด / ช่องใน, hover, หัวตาราง |
| `fg` / `fg-strong` / `muted` | `#363839` / `#0F172A` / `#5B6064` | `#E9EAE2` / `#F7F7ED` / `#9CA6B6` | ข้อความ |
| `primary` | `#0F172A` (ตัวอักษร `#F7F7ED`) | `#F7F7ED` (ตัวอักษร `#0F172A`) | ปุ่มหลักหนึ่งปุ่มต่อพื้นที่ |
| `nav-active` | gradient `#0F172A → #1D3A4F → #2B6B66` | `#22304D → #1F3F4A → #245A55` | nav ที่เลือก |
| `ai` / `ai-subtle` | `#0F766E` / `#EEF8F6` | `#80CFC0` / `#142428` | AI เท่านั้น (เดิม) |
| `beacon` / `beacon-soft` | `#F59E0B` / `#FFFAE6` | — / `#2A2414` | แสงทองในการ์ดไฮไลต์ + chip กะ (ตกแต่ง ไม่ใช่สถานะ) |
| `hl-bg` | navy gradient + glow ทอง 38% + glow seafoam 30% | โทนเดียวกันมืดลง | การ์ดไฮไลต์ |
| chart `email` / `line` / `portal` | `#5B8DEF` / `#2E9E6B` / `#7C7FF0` | `#6DA0F2` / `#3FBF85` / `#9497F5` | stacked bar (ใหม่: tokens เดิมมี series สีเดียว) |
| radius | app 28 · card 20 · inner 14 · control 12 · pill full | | เดิม: control 10, card 16, dialog 20 |
| shadow | card `0 1px 2px /4%, 0 12px 30px -18px /16%` · lift `0 16px 36px -14px /26%` · app `0 40px 90px -30px /30%` | ทึบขึ้นเป็นดำ | |
| type | ชื่อหน้า 34/300 · ตัวเลข hero 52/300 · หัวการ์ด 18/500 · body 14/400 · meta 12–12.5 · Thai line-height 1.6 · `tabular-nums` ทุกตัวเลข | | |

Contrast ที่คำนวณมือ (ยังไม่ได้ใส่ `contrast.test.ts`) `[UNVERIFIED 85%]`: `muted` บน `canvas` ≈ 5.9:1 · ivory บนปลาย gradient nav `#2B6B66` ≈ 5.7:1 · `hl-muted #C9D2DC` บน `#1C3C45` ≈ 7.7:1 · chip กะ `#6B4B0E` บน `#FFFAE6` ≈ 7.6:1 · สี chart ทั้งสามบนขาว ≥ 3.2:1 (เกณฑ์ mark 3:1)

## 3. ref → Watchtower
| องค์ประกอบใน ref | ที่ Watchtower | หมายเหตุ |
|---|---|---|
| แผ่นแอปลอยบน gradient ม่วง | แผ่นแอปบน gradient navy-mist/seafoam/cream | ม่วงแปลงเป็นโทนแบรนด์ |
| MAIN / INBOXES / OTHER | Main (Overview, Queue, Incidents, Knowledge, Shifts) · Inboxes (Email, LINE OA, Portal + จำนวน) · Other (Reports, Admin) | ไม่ใช้ตัวพิมพ์ใหญ่ (คงกฎ `friendly-polish.md` §4) |
| active pill gradient | gradient navy → teal | |
| badge แดงของ Messages | badge แดงเฉพาะ Incidents ที่มี P1 · จำนวน inbox เป็นสีกลาง | alert discipline |
| search + `⌘+Space` | search + `⌘ K` (command palette เดิม) | |
| avatar stack + Export | คนที่อยู่กะ (initials) + `New ticket` navy | |
| Customers Growth (ลูกโลก) | Open tickets: เลข hero + trend + At risk / Overdue / Unassigned + แถบ SLA met | ตัดลูกโลกออก |
| Sales Overview chart + hatched column + tooltip | Ticket volume ตามช่องทาง 7 วัน, คอลัมน์ไฮไลต์ = วันที่มี incident, tooltip แยกช่องทาง + incident ที่โยง | |
| ตาราง product + status pill + แถวที่เลือก | Needs attention: ticket (สรุป AI + severity + key + org), channel, intent, SLA pill, assignee | |
| Total Sales gauge + Goal | AI drafts: % ที่อนุมัติโดยไม่แก้ เทียบเป้า + จำนวน intent ต่อ stage | |
| การ์ด "You have sold 280 products" | "AI drafted 42 replies today — 38 approved by the team" + breakdown แก้/ปฏิเสธ | |
| (ไม่มีใน ref) | Live incidents, Open load per person, ticket workspace ทั้งหน้า | มาจาก spec §18.2, §3–§6 |

## 4. สิ่งที่ไม่เอาจาก ref และเหตุผล
- **สีม่วง/indigo เป็นแบรนด์** — ไม่ใช่สีของ Watchtower (`docs/brand/README.md`)
- **รูปถ่าย avatar** — กฎเดิมใช้ initials เท่านั้น ไม่โหลดรูปจากภายนอก (`ui-refresh-2026-11.md` §3.11)
- **ลูกโลก/ภาพประกอบใหญ่** — ไม่มีข้อมูล กินพื้นที่บนจอที่คนดู 8 ชั่วโมง
- **ป้ายเลขแดงทั่วไป** — แดงสงวนให้ P1/breach เท่านั้น (PRD §10)
- **ลูกศรเขียว = ดีเสมอ** — สี trend ตามความหมาย: ticket น้อยลง = เขียว, ปริมาณเพิ่ม = เทากลาง (ไม่ดีไม่แย่) และมีคำกำกับเสมอ
- **ข้อความฉลองแบบเกม** — การ์ดไฮไลต์บอกข้อเท็จจริง + breakdown ไม่กะพริบ ไม่มี confetti (alarm fatigue)
- **Small caps** — คงกฎไม่ใช้ ALL CAPS (ภาษาไทยไม่มีตัวพิมพ์ใหญ่ ทำให้สองภาษาดูไม่เท่ากัน)

## 5. จุดที่ตั้งใจเบี่ยงจาก design doc เดิม (N6)
| เอกสารเดิม | เดิม | ข้อเสนอ |
|---|---|---|
| `ui-refresh-2026-11.md` §3.1, §3.3 | pane คั่นด้วย hairline ไม่มีการ์ด; เงาเฉพาะ overlay | pane เป็นการ์ดลอยมี gap 16 px + เงานุ่ม |
| `ui-refresh-2026-11.md` §3.2 | ไม่มี global top bar | มีเฉพาะหน้า dashboard (Overview/Reports) |
| `ui-refresh-2026-11.md` §3.5, `friendly-polish.md` §4 | Inter + Noto Sans Thai, ชื่อ 600 | Plus Jakarta Sans + IBM Plex Sans Thai, ชื่อ 300 |
| `friendly-polish.md` §2 | radius 10 / 16 / 20 | 12 / 20 (การ์ด) / 28 (แผ่นแอป) |
| `06-UI-SPEC.md` §18.2 | Head home ไม่มี chart/trend ใน Phase 1 (ต้องมีประวัติ, T-206) | มี chart + trend chip — ตัวเลขเปรียบเทียบต้องรอ API ประวัติ; ก่อนนั้นซ่อน trend chip |
| `ai-first-workspace.md` §3 | draft อยู่ใต้ brief ตรงกลาง | draft card อยู่คอลัมน์ AI ขวา; กลางเหลือ brief ย่อ + ปุ่ม `Review draft` |

คงไว้เหมือนเดิม: ปุ่มหลัก navy, coral เฉพาะโลโก้, severity = icon + code + สี (P1 เท่านั้นที่มีขอบเข้ม), SLA badge 6 สถานะตาม spec §4.4, AI = `Bot` + teal ไม่มี sparkle, StageBadge 0–2 เท่านั้น, A/E/R + Uncited + citation, internal note เส้นประ + lock, "N new" pill, theme switch สองสถานะ default ตามระบบ, keyboard hint อยู่ใน tooltip

## 6. Component (ตรวจ `packages/ui/src/index.ts` 2026-11-02)
- **มีแล้ว ใช้ต่อ (เปลี่ยนแค่ token):** `Button`, `IconButton`, `TintChip`, `SeverityBadge`, `StageBadge`, `IntentChip`, `ConfidenceDots`, `Avatar`, `SegmentedControl`, `Tabs`, `DataTable`, `StatTile`, `BarChart`, `ChartFrame` (มี table view), `BarList`, `ThemeSwitch`, `Kbd`, `Tooltip`, `EmptyState`
- **ต้องเพิ่ม:** `AppFrame` (แผ่นลอย + backdrop), `SidebarSection` + `InboxNavItem`, `AvatarStack`, `TrendChip`, stacked mode + highlight + tooltip card ใน `BarChart`, `RadialGauge`, `HighlightCard` · token ใหม่: `canvas`, `frame`, `nav-active`, `beacon`, `hl-*`, chart ตามช่องทาง, radius/shadow ชุดใหม่ (+ คู่สีทั้งหมดใน `contrast.test.ts`)

## 7. ยังไม่ยืนยัน
- `[UNVERIFIED]` ยังไม่ได้เปิด render ใน browser จริงจาก session นี้ (เขียนไฟล์อย่างเดียว) — ให้เปิดดูที่ 1440 และ 1024 ทั้ง light/dark ก่อนตัดสิน
- `[UNVERIFIED 85%]` ค่า contrast ข้อ 2 คำนวณมือ ยังไม่ผ่าน axe/`contrast.test.ts`
- `[ASSUMED]` path ของ icon เขียนเลียนแบบ lucide ด้วยมือ บางตัวอาจไม่ตรงทรงจริง (เช่น `alarm-clock-off`)
- `[ASK-HUMAN]` Google Fonts ใน mockup เป็นปลายทาง network ใหม่ — ถ้าใช้จริงเสนอ self-host (`@fontsource/*`) ไม่เรียก Google ตอน runtime

## 8. คำถามถึงเจ้าของ (ไม่เกิน 5)
1. แผ่นแอปลอย + gradient backdrop ใช้ทุกหน้า หรือเฉพาะ Overview/Login? (เสียความกว้าง ~64 px ที่ 1440 · เสนอ: density `compact` ปิด backdrop ให้แอปเต็มจอ)
2. เปลี่ยนฟอนต์เป็น Plus Jakarta Sans + IBM Plex Sans Thai (self-host) หรือคง Inter + Noto Sans Thai?
3. Head home จะมี chart + trend ตอนนี้เลย (ต้องทำ counts/history API ก่อน) หรือคงตัวเลขอย่างเดียวจนถึง T-206?
4. Draft card อยู่คอลัมน์ AI ขวา (ตาม mockup นี้) หรือกลางใต้ brief (ตาม T-128 ปัจจุบัน)?
5. Active nav เป็น gradient navy → teal (ตาม mockup) หรือ navy ทึบล้วน? (ทางเลือก accent: เปลี่ยนแสง beacon ทองในการ์ดไฮไลต์เป็น seafoam ล้วน ถ้ารู้สึกว่าทองดูเหมือนสถานะเตือน)

### คำตอบของเจ้าของ (2026-11-02) `[CONFIRMED]`
1. แผ่นลอย + gradient backdrop **เฉพาะ Overview/Login** · หน้า queue/ticket/อื่น ๆ ใช้เต็มจอ (การ์ดลอยภายในยังใช้ได้)
2. ฟอนต์ **Plus Jakarta Sans + IBM Plex Sans Thai (+ IBM Plex Mono)** self-host ด้วย `@fontsource` ห้ามดึง Google Fonts ตอน runtime
3. chart + trend บน Head home **ทำพร้อม redesign เลย** (ต้องเพิ่ม counts/history API)
4. draft card อยู่ **คอลัมน์ AI ด้านขวา** (แทน ai-first-workspace.md §3 / T-128 เดิม)
5. active nav = **gradient navy → teal** · แสงบนการ์ดไฮไลต์ = **seafoam** (เลิกใช้ทอง กันสับสนกับสีเตือน)

### ทิศทางของ UI rework (เจ้าของตอบใน session UI rework, 2026-11-02 ราว 23:55) `[CONFIRMED]`
- ใช้ **Soft Beacon ทั้งชุด** (tokens, ฟอนต์, การ์ด, shell) พร้อมคำตอบ 5 ข้อข้างบน — ไม่ต้องให้ `po` ตัดสินแทน
- chart + trend บน Head home: **ทำ layout ตอนนี้ด้วยข้อมูลที่มี** (ปริมาณงาน 7 วันจาก read model ของ dashboard) **ซ่อน trend chip** จนกว่าจะมี counts/history API (งาน API แยก)
- คงกฎใน `docs/plans/ui-rework-brief.md` §2: สีบอกสถานะเท่านั้น, ปุ่มตัดสินใจมีข้อความ, หน้า ticket ไม่มี global top bar
