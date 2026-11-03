import { createHash } from 'node:crypto';

import type { Rng } from './prng.js';
import { DAY } from './prng.js';
import { SERVICES } from './ops.js';
import type { IncidentWindow } from './tickets.js';
import type { Row } from './types.js';
import type { World, WorldStaff } from './world.js';

/**
 * The knowledge base of the year: how-tos, troubleshooting guides, known issues and runbooks in
 * Thai and English, with several versions over time, some drafts and deprecated articles.
 */

interface Topic {
  readonly stem: string;
  readonly intents: readonly string[];
  readonly visibility: 'customer' | 'internal';
  readonly en: { title: string; intro: string; steps: readonly string[]; note: string };
  readonly th: { title: string; intro: string; steps: readonly string[]; note: string };
}

const TOPICS: readonly Topic[] = [
  {
    stem: 'webhook-endpoint-checklist',
    intents: ['webhook_not_received'],
    visibility: 'customer',
    en: {
      title: 'Webhook endpoint checklist',
      intro: 'Use this list when your endpoint does not receive events.',
      steps: [
        'Confirm the URL is reachable over HTTPS from the public internet.',
        'Answer with a 2xx status within 10 seconds and process the event afterwards.',
        'Open the delivery log and read the status of the latest attempts.',
        'Enable the event type for the endpoint and send a test event.',
      ],
      note: 'Failed deliveries are retried for up to 24 hours.',
    },
    th: {
      title: 'เช็กลิสต์ endpoint ของ webhook',
      intro: 'ใช้รายการนี้เมื่อ endpoint ของคุณไม่ได้รับ event',
      steps: [
        'ตรวจว่า URL เข้าถึงได้จากอินเทอร์เน็ตผ่าน HTTPS',
        'ตอบ 2xx ภายใน 10 วินาที แล้วค่อยประมวลผล event ภายหลัง',
        'เปิด delivery log และดูสถานะของความพยายามล่าสุด',
        'เปิดประเภท event สำหรับ endpoint แล้วส่ง test event',
      ],
      note: 'การส่งที่ล้มเหลวจะถูกลองใหม่นานถึง 24 ชั่วโมง',
    },
  },
  {
    stem: 'webhook-signature-verification',
    intents: ['webhook_not_received', 'api_error'],
    visibility: 'customer',
    en: {
      title: 'Verify webhook signatures',
      intro: 'Each webhook carries a signature header computed with your signing secret.',
      steps: [
        'Read the raw request body before any parsing.',
        'Compute the HMAC-SHA256 of the body with your secret.',
        'Compare it to the signature header with a constant-time comparison.',
        'Reject requests with a timestamp older than five minutes.',
      ],
      note: 'Proxies that rewrite headers can strip the signature; allow it through.',
    },
    th: {
      title: 'ตรวจสอบ signature ของ webhook',
      intro: 'ทุก webhook มี header ลายเซ็นที่คำนวณด้วย signing secret ของคุณ',
      steps: [
        'อ่าน raw body ของ request ก่อน parse',
        'คำนวณ HMAC-SHA256 ของ body ด้วย secret',
        'เทียบกับ header ด้วยการเปรียบเทียบแบบ constant-time',
        'ปฏิเสธ request ที่ timestamp เก่ากว่าห้านาที',
      ],
      note: 'proxy ที่แก้ header อาจทำให้ลายเซ็นหาย ควรอนุญาตให้ผ่าน',
    },
  },
  {
    stem: 'api-error-codes',
    intents: ['api_error'],
    visibility: 'customer',
    en: {
      title: 'API error codes explained',
      intro: 'What the common error codes mean and what to do about each.',
      steps: [
        'E1042: a required field is missing; check the field list in the response.',
        'E2007: the resource state does not allow the call; read it first.',
        'E3301: the request was understood but is not allowed for this key.',
        '429: slow down and retry with exponential backoff.',
      ],
      note: 'Always log the request id of a failed call; support needs it.',
    },
    th: {
      title: 'อธิบายรหัส error ของ API',
      intro: 'ความหมายของรหัส error ที่พบบ่อยและวิธีรับมือ',
      steps: [
        'E1042: ขาดฟิลด์ที่จำเป็น ดูรายการฟิลด์ในผลตอบกลับ',
        'E2007: สถานะของทรัพยากรไม่อนุญาตให้เรียก ให้อ่านสถานะก่อน',
        'E3301: เข้าใจคำขอแล้วแต่ key นี้ไม่มีสิทธิ์',
        '429: ลดความถี่และลองใหม่แบบ exponential backoff',
      ],
      note: 'บันทึก request id ของการเรียกที่ล้มเหลวไว้เสมอ ทีมซัพพอร์ตต้องใช้',
    },
  },
  {
    stem: 'api-rate-limits',
    intents: ['api_error', 'workspace_config'],
    visibility: 'customer',
    en: {
      title: 'API rate limits and how to request an increase',
      intro: 'Every key has a per-minute limit based on the plan.',
      steps: [
        'Read the X-RateLimit headers in each response.',
        'Spread bulk calls over time and use the batch endpoints.',
        'Retry 429 responses after the time in Retry-After.',
        'Ask support to raise the limit for a campaign, with dates and expected volume.',
      ],
      note: 'Temporary increases revert automatically.',
    },
    th: {
      title: 'rate limit ของ API และวิธีขอเพิ่ม',
      intro: 'ทุก key มีเพดานต่อนาทีตามแพ็กเกจ',
      steps: [
        'อ่าน header X-RateLimit ในทุกผลตอบกลับ',
        'กระจายการเรียกจำนวนมากตามเวลาและใช้ batch endpoint',
        'เมื่อได้ 429 ให้รอตามเวลาใน Retry-After แล้วลองใหม่',
        'ขอให้ซัพพอร์ตเพิ่มเพดานสำหรับแคมเปญ โดยแจ้งช่วงวันที่และปริมาณที่คาดไว้',
      ],
      note: 'การเพิ่มชั่วคราวจะกลับเป็นค่าเดิมอัตโนมัติ',
    },
  },
  {
    stem: 'batch-job-stuck',
    intents: ['processing_failure'],
    visibility: 'customer',
    en: {
      title: 'A batch job is stuck in processing',
      intro: 'Steps before contacting support.',
      steps: [
        'Check the job status page for a banner about an incident.',
        'Look at the first failed row in the job detail.',
        'Re-submit a small sample of the file to see if the error repeats.',
        'Contact support with the job id and the file reference.',
      ],
      note: 'Do not re-upload the full file repeatedly; it can create duplicates.',
    },
    th: {
      title: 'งานแบบ batch ค้างที่สถานะ processing',
      intro: 'สิ่งที่ควรทำก่อนติดต่อซัพพอร์ต',
      steps: [
        'ดูหน้าสถานะว่ามีประกาศ incident หรือไม่',
        'ดูแถวแรกที่ล้มเหลวในรายละเอียดของงาน',
        'ลองส่งไฟล์ตัวอย่างขนาดเล็กเพื่อดูว่า error ซ้ำหรือไม่',
        'ติดต่อซัพพอร์ตพร้อม job id และไฟล์อ้างอิง',
      ],
      note: 'อย่าอัปโหลดไฟล์เต็มซ้ำหลายครั้ง อาจเกิดข้อมูลซ้ำ',
    },
  },
  {
    stem: 'import-file-format',
    intents: ['processing_failure', 'feature_question'],
    visibility: 'customer',
    en: {
      title: 'Import file format and common mistakes',
      intro: 'Files are UTF-8 CSV with a header row.',
      steps: [
        'Keep the column names exactly as in the template.',
        'Use ISO dates (2026-03-14) and a dot as the decimal separator.',
        'Remove empty required cells; they fail at step 3.',
        'Split files above 50,000 rows.',
      ],
      note: 'The validation report lists the first 100 problems.',
    },
    th: {
      title: 'รูปแบบไฟล์นำเข้าและข้อผิดพลาดที่พบบ่อย',
      intro: 'ไฟล์เป็น CSV แบบ UTF-8 และมีแถวหัวตาราง',
      steps: [
        'ใช้ชื่อคอลัมน์ตรงกับเทมเพลตทุกตัวอักษร',
        'ใช้วันที่แบบ ISO (2026-03-14) และจุดทศนิยม',
        'อย่าเว้นเซลล์ที่จำเป็นให้ว่าง จะล้มที่ขั้นตอน 3',
        'แบ่งไฟล์ที่เกิน 50,000 แถว',
      ],
      note: 'รายงานตรวจสอบแสดงปัญหา 100 รายการแรก',
    },
  },
  {
    stem: 'reset-two-factor',
    intents: ['account_access'],
    visibility: 'customer',
    en: {
      title: 'Reset two-factor authentication',
      intro:
        'If you lost your device, an administrator of your workspace can reset the second factor.',
      steps: [
        'Ask your workspace administrator to open Members and choose Reset 2FA.',
        'If you are the only administrator, contact support from your registered address.',
        'Support verifies your identity with a registered contact.',
        'Sign in within 24 hours and scan the new QR code.',
      ],
      note: 'We never send passwords by email.',
    },
    th: {
      title: 'รีเซ็ต 2FA',
      intro: 'หากทำอุปกรณ์หาย ผู้ดูแล workspace รีเซ็ตปัจจัยที่สองให้ได้',
      steps: [
        'ให้ผู้ดูแล workspace เปิด Members แล้วเลือก Reset 2FA',
        'หากคุณเป็นผู้ดูแลเพียงคนเดียว ติดต่อซัพพอร์ตจากอีเมลที่ลงทะเบียน',
        'ซัพพอร์ตยืนยันตัวตนผ่านผู้ติดต่อที่ลงทะเบียน',
        'เข้าสู่ระบบภายใน 24 ชั่วโมงแล้วสแกน QR code ใหม่',
      ],
      note: 'เราไม่ส่งรหัสผ่านทางอีเมล',
    },
  },
  {
    stem: 'add-remove-members',
    intents: ['account_access', 'workspace_config'],
    visibility: 'customer',
    en: {
      title: 'Add or remove workspace members',
      intro: 'Administrators manage members under Settings.',
      steps: [
        'Open Settings > Members.',
        'Invite by email and choose a role.',
        'Remove a member when they leave; their API keys are revoked.',
        'Keep at least two administrators.',
      ],
      note: 'Role changes take effect at next sign-in.',
    },
    th: {
      title: 'เพิ่มหรือลบสมาชิก workspace',
      intro: 'ผู้ดูแลจัดการสมาชิกได้ที่ Settings',
      steps: [
        'เปิด Settings > Members',
        'เชิญด้วยอีเมลและเลือกบทบาท',
        'ลบสมาชิกเมื่อลาออก API key ของคนนั้นจะถูกเพิกถอน',
        'ควรมีผู้ดูแลอย่างน้อยสองคน',
      ],
      note: 'การเปลี่ยนบทบาทมีผลเมื่อเข้าสู่ระบบครั้งถัดไป',
    },
  },
  {
    stem: 'invoice-and-usage-explained',
    intents: ['billing_report'],
    visibility: 'customer',
    en: {
      title: 'Reading your invoice and usage report',
      intro: 'How usage is counted and billed.',
      steps: [
        'Usage is counted per successful API call, per day (UTC+7).',
        'Retries that succeed count once; failed calls are not billed.',
        'Download the daily CSV from Billing > Usage.',
        'Disputes must be raised within 30 days of the invoice date.',
      ],
      note: 'Credit notes are issued by the finance team.',
    },
    th: {
      title: 'วิธีอ่านใบแจ้งหนี้และรายงานการใช้งาน',
      intro: 'วิธีนับและเรียกเก็บการใช้งาน',
      steps: [
        'นับต่อ API call ที่สำเร็จ แยกรายวัน (UTC+7)',
        'retry ที่สำเร็จนับครั้งเดียว การเรียกที่ล้มเหลวไม่คิดเงิน',
        'ดาวน์โหลด CSV รายวันได้ที่ Billing > Usage',
        'การโต้แย้งต้องแจ้งภายใน 30 วันนับจากวันที่ใบแจ้งหนี้',
      ],
      note: 'ใบลดหนี้ออกโดยทีมการเงิน',
    },
  },
  {
    stem: 'update-billing-details',
    intents: ['billing_report'],
    visibility: 'customer',
    en: {
      title: 'Update billing address and tax details',
      intro: 'Changes apply to future invoices.',
      steps: [
        'Send the new legal name, address and tax id from a registered contact.',
        'Finance confirms the change within two business days.',
        'Ask for corrected invoices if an earlier one must change.',
      ],
      note: 'Invoices already paid are re-issued only on request.',
    },
    th: {
      title: 'แก้ไขที่อยู่และข้อมูลภาษีสำหรับใบแจ้งหนี้',
      intro: 'การเปลี่ยนแปลงมีผลกับใบแจ้งหนี้ครั้งต่อไป',
      steps: [
        'ส่งชื่อนิติบุคคล ที่อยู่ และเลขผู้เสียภาษีใหม่จากผู้ติดต่อที่ลงทะเบียน',
        'ฝ่ายการเงินยืนยันภายในสองวันทำการ',
        'ขอใบแจ้งหนี้ฉบับแก้ไขหากต้องแก้ฉบับก่อนหน้า',
      ],
      note: 'ใบที่ชำระแล้วจะออกใหม่เมื่อมีคำขอเท่านั้น',
    },
  },
  {
    stem: 'scheduled-report-export',
    intents: ['feature_question'],
    visibility: 'customer',
    en: {
      title: 'Export reports with the reports API',
      intro: 'Scheduled email delivery is not available; call the API from your scheduler.',
      steps: [
        'Create an API key with the reports scope.',
        'Call the export endpoint with the report id and format csv.',
        'Poll the returned job until it is complete and download the file.',
      ],
      note: 'Large exports run asynchronously.',
    },
    th: {
      title: 'ส่งออกรายงานด้วย reports API',
      intro: 'ยังไม่มีการส่งอีเมลตามเวลา ให้เรียก API จาก scheduler ของคุณ',
      steps: [
        'สร้าง API key ที่มี scope reports',
        'เรียก export endpoint พร้อม report id และ format csv',
        'poll งานที่ได้จนเสร็จ แล้วดาวน์โหลดไฟล์',
      ],
      note: 'การส่งออกขนาดใหญ่ทำงานแบบ asynchronous',
    },
  },
  {
    stem: 'roles-and-permissions',
    intents: ['feature_question', 'account_access'],
    visibility: 'customer',
    en: {
      title: 'Roles and permissions in a workspace',
      intro: 'Viewer, Operator and Administrator.',
      steps: [
        'Viewer: read-only, suitable for auditors.',
        'Operator: can run and edit day-to-day work.',
        'Administrator: members, billing contacts and keys.',
      ],
      note: 'Custom roles are on the roadmap.',
    },
    th: {
      title: 'บทบาทและสิทธิ์ใน workspace',
      intro: 'Viewer, Operator และ Administrator',
      steps: [
        'Viewer: อ่านอย่างเดียว เหมาะกับผู้ตรวจสอบ',
        'Operator: ทำและแก้ไขงานประจำวันได้',
        'Administrator: จัดการสมาชิก ผู้ติดต่อด้านบิล และ key',
      ],
      note: 'บทบาทแบบกำหนดเองอยู่ใน roadmap',
    },
  },
  {
    stem: 'data-retention',
    intents: ['feature_question'],
    visibility: 'customer',
    en: {
      title: 'Data retention periods',
      intro: 'How long data is kept by default.',
      steps: [
        'Operational records: 13 months.',
        'Delivery logs: 30 days.',
        'Audit records: 24 months.',
        'An administrator can request a shorter period.',
      ],
      note: 'Deleted data is purged from backups within 35 days.',
    },
    th: {
      title: 'ระยะเวลาเก็บข้อมูล',
      intro: 'ระยะเวลาเก็บข้อมูลตั้งต้น',
      steps: [
        'ข้อมูลการดำเนินงาน: 13 เดือน',
        'delivery log: 30 วัน',
        'บันทึกการตรวจสอบ: 24 เดือน',
        'ผู้ดูแลขอให้สั้นลงได้',
      ],
      note: 'ข้อมูลที่ลบจะถูกกำจัดออกจากข้อมูลสำรองภายใน 35 วัน',
    },
  },
  {
    stem: 'sandbox-workspace',
    intents: ['workspace_config'],
    visibility: 'customer',
    en: {
      title: 'Set up a sandbox workspace',
      intro: 'A sandbox mirrors production settings without production data.',
      steps: [
        'Request a sandbox from support with the project name.',
        'Use the sandbox base URL and the sandbox keys.',
        'Register separate webhook endpoints for the sandbox.',
      ],
      note: 'Sandbox data is cleared every 90 days.',
    },
    th: {
      title: 'ตั้งค่า sandbox workspace',
      intro: 'sandbox ใช้การตั้งค่าเหมือน production แต่ไม่มีข้อมูลจริง',
      steps: [
        'ขอ sandbox จากซัพพอร์ตพร้อมชื่อโปรเจกต์',
        'ใช้ base URL และ key ของ sandbox',
        'ลงทะเบียน webhook endpoint แยกสำหรับ sandbox',
      ],
      note: 'ข้อมูลใน sandbox ถูกล้างทุก 90 วัน',
    },
  },
  {
    stem: 'upstream-timeouts-customers',
    intents: ['upstream_timeout'],
    visibility: 'customer',
    en: {
      title: 'What to do when calls time out',
      intro: 'Timeouts can come from our upstream providers.',
      steps: [
        'Check the status page for a published incident.',
        'Retry with exponential backoff; do not retry in a tight loop.',
        'Use idempotency keys so retries do not duplicate work.',
        'Contact support with request ids if the status page is green.',
      ],
      note: 'We post updates every 30 minutes during an incident.',
    },
    th: {
      title: 'เมื่อการเรียกเกิด timeout ควรทำอย่างไร',
      intro: 'timeout อาจมาจากผู้ให้บริการต้นทางของเรา',
      steps: [
        'ดูหน้า status ว่ามี incident ที่ประกาศหรือไม่',
        'ลองใหม่แบบ exponential backoff ไม่ใช่ลูปถี่ ๆ',
        'ใช้ idempotency key เพื่อไม่ให้ retry ทำงานซ้ำ',
        'ติดต่อซัพพอร์ตพร้อม request id หากหน้า status ปกติ',
      ],
      note: 'ระหว่าง incident เราอัปเดตทุก 30 นาที',
    },
  },
  {
    stem: 'duplicate-or-wrong-result',
    intents: ['result_dispute'],
    visibility: 'customer',
    en: {
      title: 'Duplicate or incorrect results',
      intro: 'How to report a result that looks wrong.',
      steps: [
        'Collect the document numbers and both totals.',
        'Check whether a retry happened around the same time.',
        'Send the evidence to support; we compare against the audit trail.',
      ],
      note: 'Confirmed duplicates are refunded within three business days.',
    },
    th: {
      title: 'ผลลัพธ์ซ้ำหรือไม่ถูกต้อง',
      intro: 'วิธีแจ้งผลลัพธ์ที่ดูผิดปกติ',
      steps: [
        'รวบรวมเลขที่เอกสารและยอดทั้งสองฝั่ง',
        'ตรวจว่ามี retry ในช่วงเวลาใกล้เคียงหรือไม่',
        'ส่งหลักฐานให้ซัพพอร์ต เราจะเทียบกับ audit trail',
      ],
      note: 'รายการซ้ำที่ยืนยันแล้วจะคืนเงินภายในสามวันทำการ',
    },
  },
  {
    stem: 'status-page-subscriptions',
    intents: ['incident_inquiry'],
    visibility: 'customer',
    en: {
      title: 'Follow incidents on the status page',
      intro: 'Subscribe to be told about incidents and maintenance.',
      steps: [
        'Open the status page and choose Subscribe.',
        'Confirm the address from the email we send.',
        'Pick the components you care about.',
      ],
      note: 'You can unsubscribe from any message.',
    },
    th: {
      title: 'ติดตาม incident ผ่านหน้า status',
      intro: 'สมัครรับแจ้งเตือน incident และการบำรุงรักษา',
      steps: [
        'เปิดหน้า status แล้วเลือก Subscribe',
        'ยืนยันอีเมลจากข้อความที่เราส่งให้',
        'เลือก component ที่สนใจ',
      ],
      note: 'ยกเลิกการรับได้จากทุกข้อความ',
    },
  },
  {
    stem: 'escalate-p1',
    intents: ['incident_inquiry', 'api_error'],
    visibility: 'internal',
    en: {
      title: 'Escalating a P1 ticket',
      intro: 'Internal procedure for a priority 1 ticket.',
      steps: [
        'Confirm impact on production and the number of affected users.',
        'Page the on-call developer from the alert page.',
        'Open an incident if more than one customer reports the same symptom.',
        'Send the approved holding statement within 15 minutes.',
      ],
      note: 'Do not promise a time to recovery without the incident commander.',
    },
    th: {
      title: 'ขั้นตอน escalate ตั๋ว P1',
      intro: 'ขั้นตอนภายในสำหรับตั๋วความสำคัญระดับ 1',
      steps: [
        'ยืนยันผลกระทบต่อ production และจำนวนผู้ใช้ที่ได้รับผลกระทบ',
        'เรียก dev เวรจากหน้า alert',
        'เปิด incident หากมีลูกค้ามากกว่าหนึ่งรายแจ้งอาการเดียวกัน',
        'ส่งข้อความ holding statement ที่อนุมัติแล้วภายใน 15 นาที',
      ],
      note: 'ห้ามสัญญาเวลากลับมาปกติโดยไม่ผ่าน incident commander',
    },
  },
  {
    stem: 'handoff-between-shifts',
    intents: [],
    visibility: 'internal',
    en: {
      title: 'Shift handoff: what to include',
      intro: 'A good handoff lets the next person continue without asking.',
      steps: [
        'List every open P1 and P2 ticket with the next action.',
        'Include running incidents and recent deploys.',
        'Add watch items: anything you expect to change overnight.',
        'Confirm the handoff before clocking out.',
      ],
      note: 'Items that need acknowledgement block the next shift until answered.',
    },
    th: {
      title: 'การส่งเวร: ควรใส่อะไรบ้าง',
      intro: 'การส่งเวรที่ดีทำให้คนต่อไปทำงานต่อได้โดยไม่ต้องถาม',
      steps: [
        'ลิสต์ตั๋ว P1 และ P2 ที่ยังเปิด พร้อมสิ่งที่ต้องทำต่อ',
        'ใส่ incident ที่กำลังดำเนินอยู่และ deploy ล่าสุด',
        'เพิ่มรายการเฝ้าระวังที่คาดว่าจะเปลี่ยนในช่วงกลางคืน',
        'ยืนยันการส่งเวรก่อนลงเวลาออก',
      ],
      note: 'รายการที่ต้องรับทราบจะบล็อกเวรถัดไปจนกว่าจะตอบ',
    },
  },
  {
    stem: 'sla-pause-rules',
    intents: [],
    visibility: 'internal',
    en: {
      title: 'SLA clock: when it pauses',
      intro: 'The clock stops while we wait for the customer.',
      steps: [
        'Set the status to Waiting on customer when you ask a question.',
        'The clock resumes when the customer replies or you change the status.',
        'Business-hours policies skip nights, weekends and public holidays.',
      ],
      note: 'Check the due dates after a long pause; they move by the paused time.',
    },
    th: {
      title: 'นาฬิกา SLA: หยุดเมื่อไร',
      intro: 'นาฬิกาหยุดขณะรอลูกค้า',
      steps: [
        'ตั้งสถานะเป็น Waiting on customer เมื่อถามลูกค้า',
        'นาฬิกาเดินต่อเมื่อลูกค้าตอบหรือคุณเปลี่ยนสถานะ',
        'นโยบายแบบเวลาทำการข้ามกลางคืน วันหยุดสุดสัปดาห์ และวันหยุดนักขัตฤกษ์',
      ],
      note: 'ตรวจเวลา due หลังหยุดนาน เวลาจะเลื่อนตามเวลาที่หยุด',
    },
  },
  {
    stem: 'writing-good-replies',
    intents: [],
    visibility: 'internal',
    en: {
      title: 'Writing a good customer reply',
      intro: 'Short, specific and honest.',
      steps: [
        'Answer the question first, then explain.',
        'Quote the request id or document number the customer gave.',
        'Say what happens next and when.',
        'Never include another customer’s data.',
      ],
      note: 'AI drafts must be read and approved by a person before sending.',
    },
    th: {
      title: 'เขียนตอบลูกค้าให้ดี',
      intro: 'สั้น ชัดเจน และตรงไปตรงมา',
      steps: [
        'ตอบคำถามก่อน แล้วค่อยอธิบาย',
        'อ้างอิง request id หรือเลขเอกสารที่ลูกค้าให้มา',
        'บอกว่าขั้นต่อไปคืออะไรและเมื่อไร',
        'ห้ามใส่ข้อมูลของลูกค้ารายอื่น',
      ],
      note: 'ร่างจาก AI ต้องมีคนอ่านและอนุมัติก่อนส่งทุกครั้ง',
    },
  },
  {
    stem: 'merge-duplicate-tickets',
    intents: [],
    visibility: 'internal',
    en: {
      title: 'Merging duplicate tickets',
      intro: 'Merge when the same organization reports the same problem twice.',
      steps: [
        'Keep the older ticket as the target.',
        'Add an internal note on the duplicate with the reason.',
        'Merge from the ticket menu; the customer sees the target.',
      ],
      note: 'Tickets of different organizations are never merged.',
    },
    th: {
      title: 'การ merge ตั๋วซ้ำ',
      intro: 'merge เมื่อองค์กรเดียวกันแจ้งปัญหาเดียวกันสองครั้ง',
      steps: [
        'เก็บตั๋วที่เก่ากว่าเป็นปลายทาง',
        'เขียนบันทึกภายในที่ตั๋วซ้ำพร้อมเหตุผล',
        'merge จากเมนูตั๋ว ลูกค้าจะเห็นตั๋วปลายทาง',
      ],
      note: 'ตั๋วต่างองค์กรไม่ถูก merge',
    },
  },
  {
    stem: 'dev-handoff-template',
    intents: ['api_error', 'processing_failure'],
    visibility: 'internal',
    en: {
      title: 'Handing a ticket to a developer',
      intro: 'What a developer needs to start.',
      steps: [
        'State the symptom and the first time it was seen.',
        'List request ids, job ids and affected organizations.',
        'Attach what you already checked and ruled out.',
        'Set the status to Waiting on developer and keep replying to the customer.',
      ],
      note: 'The agent stays accountable for the customer conversation.',
    },
    th: {
      title: 'ส่งตั๋วต่อให้ dev',
      intro: 'สิ่งที่ dev ต้องใช้เพื่อเริ่มงาน',
      steps: [
        'ระบุอาการและเวลาที่พบครั้งแรก',
        'ลิสต์ request id, job id และองค์กรที่ได้รับผลกระทบ',
        'แนบสิ่งที่ตรวจแล้วและตัดออกแล้ว',
        'ตั้งสถานะ Waiting on developer และตอบลูกค้าต่อ',
      ],
      note: 'agent ยังรับผิดชอบการสนทนากับลูกค้า',
    },
  },
  {
    stem: 'line-official-account-etiquette',
    intents: ['other'],
    visibility: 'internal',
    en: {
      title: 'Answering on the LINE official account',
      intro: 'Short messages, one question at a time.',
      steps: [
        'Greet by name and answer in the customer’s language.',
        'Move long technical detail to email or the portal.',
        'Do not share logs with personal data in a chat.',
      ],
      note: 'Replies are limited by the monthly message quota.',
    },
    th: {
      title: 'ตอบลูกค้าผ่าน LINE official account',
      intro: 'ข้อความสั้น ถามทีละข้อ',
      steps: [
        'ทักด้วยชื่อและตอบเป็นภาษาของลูกค้า',
        'รายละเอียดเทคนิคยาว ๆ ให้ย้ายไปอีเมลหรือ portal',
        'ห้ามส่ง log ที่มีข้อมูลส่วนบุคคลในแชต',
      ],
      note: 'การตอบถูกจำกัดด้วยโควตาข้อความรายเดือน',
    },
  },
];

const KNOWN_ISSUE_STEPS = (cause: string): string[] => [
  `Symptom: customers see errors or delays on the affected service.`,
  `Cause: ${cause}`,
  'Workaround: retry with backoff; the status page lists live updates.',
  'Status: fixed. Contact support if you still see the symptom.',
];

function md(
  title: string,
  intro: string,
  steps: readonly string[],
  note: string,
  extra = '',
): string {
  return `# ${title}\n\n${intro}\n\n## Steps\n\n${steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n')}\n\n## Notes\n\n${note}${extra ? `\n\n${extra}` : ''}\n`;
}

const hashOf = (title: string, body: string): string =>
  createHash('sha256').update(title, 'utf8').update('\u0000').update(body, 'utf8').digest('hex');

export interface KbPlanInput {
  readonly rng: Rng;
  readonly world: World;
  readonly now: Date;
  readonly start: Date;
  readonly windows: readonly IncidentWindow[];
  readonly themes: readonly {
    title: string;
    cause: string;
    services: readonly string[];
    severity: string;
  }[];
  readonly ticketRefs: readonly { id: string; intentKey: string; orgId: string }[];
}

export interface KbPlanOutput {
  readonly tables: Map<string, Row[]>;
  readonly runbookBySlug: Map<string, string>;
}

const EDIT_NOTES = [
  'Clarified the order of the steps',
  'Added the case seen in recent tickets',
  'Reviewed after an incident; updated the workaround',
  'Corrected a wrong limit',
  'Translated wording reviewed by a native speaker',
  'Added a link to the related runbook',
];

export function planKb(input: KbPlanInput): KbPlanOutput {
  const { rng, world, now, start } = input;
  const tables = new Map<string, Row[]>([
    ['kb_article', []],
    ['kb_article_version', []],
    ['kb_article_org', []],
    ['outbox', []],
  ]);
  const articles = tables.get('kb_article') as Row[];
  const versions = tables.get('kb_article_version') as Row[];
  const articleOrgs = tables.get('kb_article_org') as Row[];
  const outbox = tables.get('outbox') as Row[];
  const runbookBySlug = new Map<string, string>();
  const writers = world.staff.filter((s) => s.role === 'agent' || s.role === 'lead');
  const reviewers = world.staff.filter((s) => s.role === 'lead' || s.role === 'head');
  const devs = world.staff.filter((s) => s.role === 'dev');

  interface Spec {
    slug: string;
    kind: 'article' | 'runbook';
    lang: 'th' | 'en';
    visibility: 'customer' | 'internal' | 'orgs';
    intents: string[];
    versions: { title: string; body: string }[];
    author: WorldStaff;
    ageDays: number;
    status: 'published' | 'draft' | 'in_review' | 'deprecated';
    sources: { type: string; ref: string }[];
    orgs: string[];
    serviceSlug?: string;
  }
  const specs: Spec[] = [];

  TOPICS.forEach((topic, index) => {
    for (const lang of ['en', 'th'] as const) {
      const text = topic[lang];
      const v1 = md(
        text.title,
        text.intro,
        text.steps.slice(0, Math.max(2, text.steps.length - 1)),
        text.note,
      );
      const v2 = md(text.title, text.intro, text.steps, text.note);
      const v3 = md(
        text.title,
        text.intro,
        text.steps,
        text.note,
        lang === 'th'
          ? 'ดูบทความที่เกี่ยวข้องในศูนย์ความรู้'
          : 'See also the related articles in the knowledge base.',
      );
      const count = rng.weighted<number>([
        [1, 3],
        [2, 4],
        [3, 3],
        [4, 1],
      ]);
      const chain = [v1, v2, v3, v3 + '\n'].slice(0, count);
      const roll = rng.next();
      const status: Spec['status'] =
        roll < 0.78
          ? 'published'
          : roll < 0.86
            ? 'draft'
            : roll < 0.91
              ? 'in_review'
              : 'deprecated';
      const ticketMatches = input.ticketRefs.filter((t) => topic.intents.includes(t.intentKey));
      const sources =
        ticketMatches.length > 0
          ? rng
              .shuffle(ticketMatches)
              .slice(0, rng.int(0, 2))
              .map((t) => ({ type: 'ticket', ref: t.id }))
          : [];
      specs.push({
        slug: `${topic.stem}${lang === 'th' ? '-th' : ''}`,
        kind: 'article',
        lang,
        visibility: topic.visibility === 'customer' && rng.chance(0.15) ? 'orgs' : topic.visibility,
        intents: [...topic.intents],
        versions: chain.map((body) => ({ title: text.title, body })),
        author: rng.pick(writers),
        ageDays: 355 - index * 6 - (lang === 'th' ? 5 : 0) - rng.int(0, 20),
        status,
        sources,
        orgs: [],
      });
    }
  });

  // Runbooks: one per service, English and Thai.
  for (const svc of SERVICES) {
    for (const lang of ['en', 'th'] as const) {
      const title = lang === 'en' ? `Runbook: ${svc.name}` : `Runbook: ${svc.name} (ไทย)`;
      const steps =
        lang === 'en'
          ? [
              `Open the dashboard for ${svc.name} and confirm the alert is real.`,
              'Check the last three deploys of the service; roll back if the alert started after one.',
              'Look at error rate, latency and saturation for the last hour.',
              'If customer impact is confirmed, open an incident and page the on-call developer.',
              'Post updates on the incident page every 30 minutes.',
            ]
          : [
              `เปิด dashboard ของ ${svc.name} และยืนยันว่า alert เป็นเรื่องจริง`,
              'ตรวจ deploy สามครั้งล่าสุดของบริการ ถ้า alert เริ่มหลัง deploy ให้ rollback',
              'ดู error rate, latency และ saturation ในหนึ่งชั่วโมงที่ผ่านมา',
              'หากยืนยันผลกระทบต่อลูกค้า ให้เปิด incident และเรียก dev เวร',
              'อัปเดตที่หน้า incident ทุก 30 นาที',
            ];
      const intro =
        lang === 'en'
          ? `Operational runbook for ${svc.name}. Alerts handled: ${svc.alertTitles.join('; ')}.`
          : `คู่มือปฏิบัติการสำหรับ ${svc.name} alert ที่ครอบคลุม: ${svc.alertTitles.join('; ')}`;
      const body = md(
        title,
        intro,
        steps,
        lang === 'en'
          ? 'Dashboards and ownership are listed in the service catalog.'
          : 'dashboard และผู้รับผิดชอบดูได้ในแคตตาล็อกบริการ',
      );
      const body2 = md(
        title,
        intro,
        [
          ...steps,
          lang === 'en'
            ? 'Record what you changed in the incident timeline.'
            : 'บันทึกสิ่งที่แก้ไขใน timeline ของ incident',
        ],
        lang === 'en'
          ? 'Dashboards and ownership are listed in the service catalog.'
          : 'dashboard และผู้รับผิดชอบดูได้ในแคตตาล็อกบริการ',
      );
      specs.push({
        slug: `runbook-${svc.slug}${lang === 'th' ? '-th' : ''}`,
        kind: 'runbook',
        lang,
        visibility: 'internal',
        intents: [],
        versions: [
          { title, body },
          { title, body: body2 },
        ],
        author: rng.pick(devs),
        ageDays: 340 - rng.int(0, 60),
        status: 'published',
        sources: [],
        orgs: [],
        serviceSlug: svc.slug,
      });
    }
  }

  // Known issues and post-incident summaries from the year's incidents.
  input.windows.forEach((win, index) => {
    const theme = input.themes[index];
    if (!theme || theme.cause === '') return;
    const ageDays = Math.max(1, Math.floor((now.getTime() - win.startsAt.getTime()) / DAY) - 1);
    const title = `Known issue: ${theme.title}`;
    const body = md(
      title,
      `Seen on ${win.startsAt.toISOString().slice(0, 10)}. Services: ${theme.services.join(', ')}.`,
      KNOWN_ISSUE_STEPS(theme.cause),
      'Linked to the incident record; customers were informed through the status page and ticket updates.',
    );
    specs.push({
      slug: `known-issue-${String(index + 1).padStart(2, '0')}-${theme.services[0] ?? 'service'}`,
      kind: 'article',
      lang: 'en',
      visibility: win.severity === 'SEV1' || win.severity === 'SEV2' ? 'customer' : 'internal',
      intents: [...win.intentKeys],
      versions: [{ title, body }],
      author: rng.pick(writers),
      ageDays,
      status: 'published',
      sources: [{ type: 'incident', ref: win.id }],
      orgs: [],
    });
    if (index % 3 === 0) {
      const thTitle = `ปัญหาที่ทราบ: ${theme.title}`;
      specs.push({
        slug: `known-issue-${String(index + 1).padStart(2, '0')}-${theme.services[0] ?? 'service'}-th`,
        kind: 'article',
        lang: 'th',
        visibility: 'customer',
        intents: [...win.intentKeys],
        versions: [
          {
            title: thTitle,
            body: md(
              thTitle,
              `พบเมื่อ ${win.startsAt.toISOString().slice(0, 10)} บริการที่เกี่ยวข้อง: ${theme.services.join(', ')}`,
              [
                'อาการ: ลูกค้าพบ error หรือความล่าช้าในบริการที่ได้รับผลกระทบ',
                'วิธีเลี่ยงชั่วคราว: ลองใหม่แบบ backoff และติดตามหน้า status',
                'สถานะ: แก้ไขแล้ว หากยังพบอาการให้ติดต่อซัพพอร์ต',
              ],
              'เชื่อมกับบันทึก incident',
            ),
          },
        ],
        author: rng.pick(writers),
        ageDays: Math.max(1, ageDays - 2),
        status: 'published',
        sources: [{ type: 'incident', ref: win.id }],
        orgs: [],
      });
    }
  });

  // Customer-specific articles (visible to selected organizations only).
  const goldOrgs = world.orgs.filter((o) => o.tier === 'gold');
  for (const org of goldOrgs.slice(0, 4)) {
    const title = `Integration notes for ${org.name}`;
    const body = md(
      title,
      `Agreed settings and contacts for the integration of ${org.name}.`,
      [
        'Production keys are rotated every 90 days.',
        'Webhook endpoint and retry window are agreed with the customer.',
        'Escalation goes to the customer’s operations manager first.',
      ],
      'Visible to this organization only.',
    );
    specs.push({
      slug: `integration-notes-${org.domain.split('.')[0] ?? 'org'}`,
      kind: 'article',
      lang: org.lang,
      visibility: 'orgs',
      intents: ['workspace_config'],
      versions: [
        { title, body },
        { title, body: body + '\nUpdated contacts after the quarterly review.\n' },
      ],
      author: rng.pick(writers),
      ageDays: Math.max(5, Math.floor((now.getTime() - org.createdAt.getTime()) / DAY) - 30),
      status: 'published',
      sources: [],
      orgs: [org.id],
    });
  }

  // --- rows ---
  specs.forEach((spec) => {
    if (spec.visibility === 'orgs' && spec.orgs.length === 0) {
      spec.orgs = rng
        .shuffle(world.orgs.filter((o) => o.tier !== 'standard'))
        .slice(0, 2)
        .map((o) => o.id);
    }
    const articleId = rng.uuid();
    const createdAt = new Date(
      Math.max(start.getTime() - 20 * DAY, now.getTime() - spec.ageDays * DAY),
    );
    const reviewer = rng.pick(reviewers.filter((r) => r.id !== spec.author.id));
    const versionIds = spec.versions.map(() => rng.uuid());
    let at = createdAt;
    spec.versions.forEach((v, i) => {
      if (i > 0) at = new Date(Math.min(now.getTime() - DAY, at.getTime() + rng.int(20, 90) * DAY));
      versions.push({
        id: versionIds[i],
        article_id: articleId,
        version: i + 1,
        title: v.title,
        body_md: v.body,
        change_note: i === 0 ? 'First version' : rng.pick(EDIT_NOTES),
        content_hash: hashOf(v.title, v.body),
        created_by: (i % 2 === 0 ? spec.author : rng.pick(writers)).id,
        authored_by_machine: false,
        requested_by: null,
        created_at: at,
      });
    });
    const lastVersionAt = at;
    const currentId = versionIds[versionIds.length - 1] as string;
    const published = spec.status === 'published' || spec.status === 'deprecated';
    const publishedVersionId = published
      ? spec.status === 'deprecated'
        ? (versionIds[0] as string)
        : currentId
      : spec.versions.length > 1 && spec.status === 'in_review'
        ? (versionIds[0] as string)
        : null;
    const publishedAt = publishedVersionId
      ? new Date(createdAt.getTime() + rng.int(1, 6) * DAY)
      : null;
    const status =
      publishedVersionId === null && (spec.status === 'in_review' || spec.status === 'draft')
        ? spec.status
        : spec.status === 'in_review' && publishedVersionId
          ? 'published'
          : spec.status;
    articles.push({
      id: articleId,
      slug: spec.slug,
      kind: spec.kind,
      lang: spec.lang,
      status: status === 'deprecated' ? 'deprecated' : status,
      visibility: spec.visibility,
      intent_tags: spec.intents,
      author_id: spec.author.id,
      reviewer_id: published ? reviewer.id : null,
      last_verified_at: published
        ? new Date(Math.min(now.getTime(), lastVersionAt.getTime() + rng.int(0, 120) * DAY))
        : null,
      sources: spec.sources,
      current_version_id: currentId,
      published_version_id: publishedVersionId,
      published_at: publishedAt,
      break_glass_pending: false,
      created_at: createdAt,
      updated_at: lastVersionAt,
    });
    for (const orgId of spec.orgs) articleOrgs.push({ article_id: articleId, org_id: orgId });
    if (spec.serviceSlug && spec.lang === 'en') runbookBySlug.set(spec.serviceSlug, articleId);
    if (publishedVersionId && spec.status === 'published') {
      outbox.push({
        id: rng.uuid(),
        queue: 'kb',
        job_name: 'embed_article',
        job_id: `kb-embed-${publishedVersionId}-year`,
        payload: { articleId, versionId: publishedVersionId },
        options: {
          attempts: 4,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
      });
    }
  });
  return { tables, runbookBySlug };
}
