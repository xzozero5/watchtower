import type { Rng } from './prng.js';
import type { Lang } from './world.js';

/**
 * Message text of the one-year scenario, Thai and English. Placeholders in braces are filled by
 * `fillText`. All identifiers (request ids, endpoints, error codes) are invented.
 */

export interface Opening {
  readonly subject: string;
  readonly body: string;
}

export interface IntentContent {
  readonly openings: Record<Lang, readonly Opening[]>;
  readonly resolutions: Record<Lang, readonly string[]>;
  /** What an agent writes as an internal note while investigating (English; a team language). */
  readonly notes: readonly string[];
  readonly notesTh: readonly string[];
  /** Questions an agent asks the customer when the first message is not enough. */
  readonly asks: Record<Lang, readonly string[]>;
}

export const INTENT_CONTENT: Record<string, IntentContent> = {
  api_error: {
    openings: {
      en: [
        {
          subject: 'HTTP 500 on {endpoint} since this morning',
          body: 'Hello team,\n\nSince about {when} our integration gets HTTP 500 from {endpoint} on the {env} environment. It worked yesterday and we did not change anything on our side. The request id of the latest failure is {ref}.\n\nCould you please check? This blocks our {entity}.',
        },
        {
          subject: 'Intermittent 502 from the API gateway',
          body: 'Hi,\n\nWe see random 502 responses from {endpoint}, roughly {n} out of 100 calls, starting around {when}. Retrying usually works. Example request id: {ref}. Is there a known problem on your side?',
        },
        {
          subject: 'Error {code} when creating {entity}',
          body: 'Hello,\n\nCalling {endpoint} returns error {code} for every request since {when}. Payload was not changed. Request id {ref}. Please advise what the error means and how we can fix it.',
        },
      ],
      th: [
        {
          subject: 'เรียก {endpoint} แล้วได้ HTTP 500 ตั้งแต่เช้า',
          body: 'สวัสดีครับทีมซัพพอร์ต\n\nตั้งแต่ประมาณ {when} ระบบของเราเรียก {endpoint} บน {env} แล้วได้ HTTP 500 ตลอด เมื่อวานยังใช้ได้ปกติและฝั่งเราไม่ได้แก้อะไร request id ล่าสุดคือ {ref}\n\nรบกวนช่วยตรวจสอบให้หน่อยครับ ตอนนี้กระทบงาน{entity}ของเราอยู่',
        },
        {
          subject: 'API ตอบ 502 เป็นระยะ ๆ',
          body: 'สวัสดีค่ะ\n\nพบว่า {endpoint} ตอบ 502 แบบสุ่ม ประมาณ {n} ครั้งจาก 100 ครั้ง เริ่มตั้งแต่ราว {when} ลอง retry แล้วบางครั้งผ่าน ตัวอย่าง request id: {ref} ไม่ทราบว่าฝั่งระบบมีปัญหาอยู่หรือเปล่าคะ',
        },
        {
          subject: 'สร้าง{entity}ไม่ได้ ขึ้น error {code}',
          body: 'สวัสดีครับ\n\nเรียก {endpoint} แล้วได้ error {code} ทุกครั้งตั้งแต่ {when} payload ไม่ได้เปลี่ยนจากเดิม request id {ref} ช่วยอธิบายความหมายของ error นี้และแนวทางแก้ไขด้วยครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'We found the cause: a deploy on our side changed the validation of {endpoint}. We rolled it back at {when} and your requests with id {ref} now succeed. We are sorry for the trouble; a regression test is being added so this does not repeat.',
        'The errors came from a rate limit on your API key that was reached after the traffic increase. We raised the limit and added a note to your account. Please also add a retry with backoff on 429/502, as described in our integration guide.',
      ],
      th: [
        'ตรวจพบสาเหตุแล้วครับ การ deploy ฝั่งเราทำให้การ validate ของ {endpoint} เปลี่ยนไป เราได้ rollback เรียบร้อยเมื่อ {when} request id {ref} ของคุณเรียกซ้ำแล้วสำเร็จ ขออภัยในความไม่สะดวก เรากำลังเพิ่ม regression test เพื่อไม่ให้เกิดซ้ำ',
        'สาเหตุคือ API key ของคุณชน rate limit หลังปริมาณการเรียกเพิ่มขึ้นค่ะ เราปรับเพดานให้แล้วและบันทึกไว้ในบัญชี แนะนำให้เพิ่ม retry แบบ backoff เมื่อได้ 429/502 ตามคู่มือการเชื่อมต่อด้วยนะคะ',
      ],
    },
    notes: [
      'Reproduced with the customer key on staging. Gateway logs show upstream resets at the time window; correlating with the last deploy.',
      'Checked error rate per API key: only this tenant is affected, so not a platform-wide outage. Looking at their payload schema changes.',
      'Dev confirms a validation regression introduced in the last release. Hotfix prepared, waiting for review.',
    ],
    notesTh: [
      'ตรวจ log ของ gateway แล้ว พบ error เฉพาะ tenant นี้ ไม่ใช่ปัญหาทั้งระบบ กำลังดู payload ที่ส่งมา',
    ],
    asks: {
      en: [
        'Could you share the full request and response (with secrets removed) and the exact UTC time of one failing call?',
        'Which environment and API key prefix are you using? A screenshot of the error response would help too.',
      ],
      th: [
        'รบกวนส่ง request/response เต็ม ๆ (ลบข้อมูลลับออกแล้ว) และเวลาที่แน่นอนของการเรียกที่ล้มเหลวหนึ่งครั้งได้ไหมครับ',
        'ใช้ environment และ API key ขึ้นต้นด้วยอะไรคะ ถ้าแนบภาพหน้าจอ error มาด้วยจะช่วยได้มากค่ะ',
      ],
    },
  },
  webhook_not_received: {
    openings: {
      en: [
        {
          subject: 'Webhook events are not arriving',
          body: 'Hello,\n\nOur endpoint stopped receiving webhook events around {when}. The delivery log in the dashboard shows attempts for order {ref}, but our server logs show nothing. Nothing changed in our firewall as far as we know.',
        },
        {
          subject: 'Missing webhook for {entity} {ref}',
          body: 'Hi team,\n\nWe expected a webhook for {entity} {ref} but never got it. Other events arrive fine. Can you tell us whether it was sent and what our endpoint answered?',
        },
        {
          subject: 'Webhook signature verification fails',
          body: 'Hello,\n\nSince {when} every webhook fails signature verification on our side (error {code}). We did not rotate the secret. Please check whether the signing changed.',
        },
      ],
      th: [
        {
          subject: 'ไม่ได้รับ webhook ตั้งแต่เมื่อวาน',
          body: 'สวัสดีครับ\n\nendpoint ของเราไม่ได้รับ webhook ตั้งแต่ประมาณ {when} ใน delivery log บน dashboard เห็นว่ามีการส่งของรายการ {ref} แต่ log ฝั่งเราไม่เห็นอะไรเลย เท่าที่ทราบไม่ได้แก้ firewall',
        },
        {
          subject: 'webhook ของ{entity} {ref} หายไป',
          body: 'สวัสดีค่ะ\n\nรอ webhook ของ{entity} {ref} แต่ไม่ได้รับ event อื่นยังมาปกติ ช่วยเช็คให้หน่อยว่าส่งออกไปหรือยัง และ endpoint เราตอบกลับอะไรคะ',
        },
        {
          subject: 'ตรวจ signature ของ webhook ไม่ผ่าน',
          body: 'สวัสดีครับ\n\nตั้งแต่ {when} webhook ทุกตัวตรวจ signature ไม่ผ่านที่ฝั่งเรา (error {code}) เราไม่ได้เปลี่ยน secret รบกวนตรวจว่าวิธี sign เปลี่ยนไปหรือเปล่าครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'The delivery log shows your endpoint answered with a timeout (over 10 seconds) so deliveries were paused after repeated failures. We re-enabled the endpoint and replayed the {n} missed events; they were delivered successfully at {when}. Please acknowledge quickly and process asynchronously.',
        'The event type was not enabled for this endpoint after the last settings change. We enabled it and resent event {ref}. The article "Your webhook endpoint does not receive events" lists the checks for next time.',
      ],
      th: [
        'จาก delivery log พบว่า endpoint ของคุณตอบช้าเกิน 10 วินาที ระบบจึงหยุดส่งชั่วคราวหลังล้มเหลวซ้ำ เราเปิดใช้ endpoint อีกครั้งและส่ง event ที่ตกหล่น {n} รายการซ้ำแล้ว ส่งสำเร็จเมื่อ {when} แนะนำให้ตอบรับทันทีแล้วประมวลผลทีหลังนะครับ',
        'หลังเปลี่ยนการตั้งค่าครั้งล่าสุด event ประเภทนี้ถูกปิดไว้สำหรับ endpoint นี้ค่ะ เราเปิดให้แล้วและส่ง event {ref} ซ้ำเรียบร้อย ถ้าเกิดอีกลองดูขั้นตอนตรวจสอบในบทความ "endpoint ของคุณไม่ได้รับ webhook" ได้เลยค่ะ',
      ],
    },
    notes: [
      'Delivery log: 14 attempts, all timed out after 10s. Endpoint auto-disabled by the dispatcher after the failure threshold.',
      'Signature algorithm unchanged. Customer proxy strips the signature header; asked them to allow X-Signature through.',
    ],
    notesTh: ['dispatcher ปิด endpoint อัตโนมัติหลัง timeout ซ้ำ ต้อง re-enable และ replay event'],
    asks: {
      en: [
        'Which URL is registered for the endpoint, and can you check your server and proxy logs for incoming POST requests around that time?',
        'Does your endpoint answer within 10 seconds? Please share the HTTP status you return.',
      ],
      th: [
        'URL ที่ลงทะเบียนไว้คืออะไร และช่วยเช็ค log ของ server/proxy ว่ามี POST เข้ามาช่วงเวลานั้นไหมครับ',
        'endpoint ตอบกลับภายใน 10 วินาทีหรือเปล่าคะ ขอ HTTP status ที่ส่งกลับด้วยค่ะ',
      ],
    },
  },
  processing_failure: {
    openings: {
      en: [
        {
          subject: 'Batch {ref} stuck in processing',
          body: 'Hello,\n\nOur {entity} batch {ref} has been "processing" since {when} and never completes. {n} items are affected. Can you check the job on your side?',
        },
        {
          subject: 'Several jobs failed overnight',
          body: 'Hi,\n\n{n} jobs failed during the night run with status "failed" and no message. Job ids start with {ref}. We need them processed before the morning cut-off.',
        },
        {
          subject: 'Import fails at step 3 with {code}',
          body: 'Hello team,\n\nThe import for {entity} stops at step 3 and shows {code}. We tried twice with a smaller file and got the same result. File reference {ref}.',
        },
      ],
      th: [
        {
          subject: 'งานชุด {ref} ค้างสถานะ processing',
          body: 'สวัสดีครับ\n\nงาน{entity}ชุด {ref} ค้างสถานะ "processing" ตั้งแต่ {when} ไม่จบสักที มี {n} รายการได้รับผลกระทบ รบกวนตรวจสอบ job ฝั่งระบบให้หน่อยครับ',
        },
        {
          subject: 'งานล้มเหลวหลายรายการตอนกลางคืน',
          body: 'สวัสดีค่ะ\n\nรอบรันกลางคืนมี {n} งานที่สถานะ failed โดยไม่มีข้อความ job id ขึ้นต้นด้วย {ref} ต้องการให้ประมวลผลให้เสร็จก่อนปิดรอบเช้าค่ะ',
        },
        {
          subject: 'นำเข้าข้อมูลไม่ผ่านที่ขั้นตอน 3 ขึ้น {code}',
          body: 'สวัสดีครับ\n\nการนำเข้า{entity}หยุดที่ขั้นตอน 3 และขึ้น {code} ลองใหม่สองครั้งด้วยไฟล์เล็กลงก็ได้ผลเหมือนเดิม ไฟล์อ้างอิง {ref}',
        },
      ],
    },
    resolutions: {
      en: [
        'The worker that picked up batch {ref} crashed on a malformed row, which left the job in "processing". We removed the row, restarted the batch and all {n} items completed at {when}. A validation step will now reject such rows with a clear message.',
        'The night run hit a temporary database failover on our side. We re-queued the failed jobs and they finished successfully. No data was lost. Sorry for the delay to your morning cut-off.',
      ],
      th: [
        'worker ที่รับงานชุด {ref} ล้มจากแถวข้อมูลที่รูปแบบผิด ทำให้งานค้างที่ processing เราตัดแถวนั้นออกและรันใหม่ ทั้ง {n} รายการเสร็จเมื่อ {when} ต่อไประบบจะปฏิเสธแถวแบบนี้พร้อมข้อความที่ชัดเจนครับ',
        'รอบกลางคืนชนช่วงที่ฐานข้อมูลฝั่งเรา failover ชั่วคราวค่ะ เราสั่งรันงานที่ล้มเหลวใหม่แล้วเสร็จครบ ไม่มีข้อมูลสูญหาย ขออภัยที่ทำให้ล่าช้าก่อนปิดรอบเช้าค่ะ',
      ],
    },
    notes: [
      'Worker log shows unhandled exception on row 8412 (null in required column). Job stays in processing because the lock was not released.',
      'Re-queued failed jobs with a dedicated queue priority; watching the dashboard for retries.',
    ],
    notesTh: ['พบ exception ที่แถว 8412 lock ไม่ถูกปล่อย job เลยค้าง ต้อง requeue'],
    asks: {
      en: [
        'Can you send the file or export for batch {ref}, or at least the first rows (without personal data)?',
        'Did the batch run partially before it stopped? Please tell us how many items completed.',
      ],
      th: [
        'ขอไฟล์หรือ export ของงานชุด {ref} หรืออย่างน้อยแถวแรก ๆ (ไม่รวมข้อมูลส่วนบุคคล) ได้ไหมครับ',
        'งานเดินไปบางส่วนก่อนหยุดหรือเปล่าคะ มีกี่รายการที่เสร็จแล้วบ้างคะ',
      ],
    },
  },
  upstream_timeout: {
    openings: {
      en: [
        {
          subject: 'Timeouts when calling the pricing lookup',
          body: 'Hello,\n\nCalls to {endpoint} time out after 30 seconds since {when}. The rest of the application is fine. Is the upstream provider having problems? Request id {ref}.',
        },
        {
          subject: 'Slow responses and gateway timeouts',
          body: 'Hi team,\n\nThe {entity} screen takes more than a minute and then shows a gateway timeout. This started around {when} for all our users. Reference {ref}.',
        },
        {
          subject: 'Upstream carrier lookup not responding',
          body: 'Hello,\n\nShipping rate lookups return "upstream timeout" for about {n} minutes now. Customers cannot finish checkout. Please advise.',
        },
      ],
      th: [
        {
          subject: 'เรียก {endpoint} แล้ว timeout',
          body: 'สวัสดีครับ\n\nตั้งแต่ {when} การเรียก {endpoint} timeout ที่ 30 วินาที ส่วนอื่นของระบบยังปกติ ผู้ให้บริการต้นทางมีปัญหาหรือเปล่าครับ request id {ref}',
        },
        {
          subject: 'หน้า{entity}ช้ามากและขึ้น gateway timeout',
          body: 'สวัสดีค่ะ\n\nหน้า{entity}ใช้เวลานานเกินหนึ่งนาทีแล้วขึ้น gateway timeout เริ่มราว {when} กระทบผู้ใช้ทุกคนของเรา อ้างอิง {ref} ค่ะ',
        },
        {
          subject: 'เช็กค่าขนส่งไม่ตอบสนองมา {n} นาทีแล้ว',
          body: 'สวัสดีครับ\n\nการเช็กค่าขนส่งขึ้น "upstream timeout" มาประมาณ {n} นาทีแล้ว ลูกค้าชำระเงินไม่ได้ รบกวนแจ้งแนวทางด้วยครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'The upstream provider had a partial outage between {when} and recovery; we switched your lookups to the secondary route and enabled a longer timeout with caching. Latency is back to normal and the provider has confirmed the fix. Details are in the incident summary.',
        'Our connection pool to the provider was exhausted after a traffic spike. We increased the pool, restarted the affected pods and verified with your request id {ref}. We are adding an alert on pool saturation.',
      ],
      th: [
        'ผู้ให้บริการต้นทางมีปัญหาบางส่วนตั้งแต่ {when} จนกลับมาปกติ เราสลับการเรียกของคุณไปเส้นทางสำรองและเพิ่ม timeout พร้อม cache ตอนนี้ latency กลับมาปกติและผู้ให้บริการยืนยันว่าแก้แล้ว รายละเอียดอยู่ในสรุป incident ครับ',
        'connection pool ไปยังผู้ให้บริการเต็มหลังทราฟฟิกพุ่งค่ะ เราเพิ่มขนาด pool และรีสตาร์ท pod ที่เกี่ยวข้อง ตรวจกับ request id {ref} ของคุณแล้วผ่าน และกำลังเพิ่ม alert เมื่อ pool ใกล้เต็มค่ะ',
      ],
    },
    notes: [
      'Upstream status page confirms degraded performance. Our p95 for this route went from 400ms to 28s at the same time.',
      'Linked to the open incident; customer tickets are being grouped under it for comms.',
    ],
    notesTh: ['ต้นทางมี degraded performance ตรงกับเวลาที่ลูกค้าแจ้ง ผูกกับ incident แล้ว'],
    asks: {
      en: [
        'Can you tell us the exact time the timeouts started and whether all regions are affected?',
      ],
      th: ['ช่วยระบุเวลาที่เริ่ม timeout ที่แน่นอน และมีผลกับทุกสาขา/ทุกภูมิภาคไหมครับ'],
    },
  },
  account_access: {
    openings: {
      en: [
        {
          subject: 'Cannot log in after password reset',
          body: 'Hello,\n\nI reset my password this morning but the login page still says "invalid credentials". My colleague has the same problem. Account: {user}.',
        },
        {
          subject: 'Please add a new admin user',
          body: 'Hi team,\n\nWe have a new colleague, {user}, who needs admin access to our workspace. Our current admin is on leave, so I am writing from the shared mailbox. How do we proceed?',
        },
        {
          subject: 'Two-factor code not accepted',
          body: 'Hello,\n\nThe 6-digit code from my authenticator app is rejected since I changed my phone. I am locked out of {user}. Please help me reset the second factor.',
        },
      ],
      th: [
        {
          subject: 'รีเซ็ตรหัสผ่านแล้วแต่ยังเข้าสู่ระบบไม่ได้',
          body: 'สวัสดีครับ\n\nรีเซ็ตรหัสผ่านเมื่อเช้าแล้ว แต่หน้า login ยังขึ้นว่า "ข้อมูลไม่ถูกต้อง" เพื่อนร่วมงานก็เป็นเหมือนกัน บัญชี: {user}',
        },
        {
          subject: 'ขอเพิ่มผู้ดูแลระบบคนใหม่',
          body: 'สวัสดีค่ะ\n\nมีพนักงานใหม่ชื่อ {user} ต้องการสิทธิ์ admin ใน workspace ของเรา แต่ admin คนเดิมลาพักอยู่ จึงส่งจากกล่องอีเมลกลาง ต้องทำอย่างไรคะ',
        },
        {
          subject: 'รหัส 2FA ใช้ไม่ได้หลังเปลี่ยนโทรศัพท์',
          body: 'สวัสดีครับ\n\nรหัส 6 หลักจากแอป authenticator ใช้ไม่ได้ตั้งแต่เปลี่ยนเครื่องโทรศัพท์ ตอนนี้เข้าบัญชี {user} ไม่ได้ ช่วยรีเซ็ต 2FA ให้หน่อยครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'After verifying your identity through the registered contact, we reset the second factor and sent a new setup link to {user}. Please sign in within 24 hours and scan the new QR code. Here is our guide: "Reset your password".',
        'The reset link had expired and an old session was holding the account. We cleared the session and issued a fresh link; you can now sign in. For admin changes we need a written request from a registered contact, which we received.',
      ],
      th: [
        'หลังยืนยันตัวตนผ่านผู้ติดต่อที่ลงทะเบียนไว้ เราได้รีเซ็ต 2FA และส่งลิงก์ตั้งค่าใหม่ไปที่ {user} แล้ว กรุณาเข้าสู่ระบบภายใน 24 ชั่วโมงและสแกน QR code ใหม่ครับ',
        'ลิงก์รีเซ็ตหมดอายุและมี session เก่าค้างอยู่ค่ะ เราล้าง session และออกลิงก์ใหม่ให้แล้ว ตอนนี้เข้าสู่ระบบได้ สำหรับการเพิ่มผู้ดูแลต้องมีคำขอเป็นลายลักษณ์อักษรจากผู้ติดต่อที่ลงทะเบียน ซึ่งเราได้รับแล้วค่ะ',
      ],
    },
    notes: [
      'Verified requester against the registered contact list. Cleared sessions and issued a new setup link (no password sent over email).',
      'Account was locked after 5 failed attempts; unlocked after verification.',
    ],
    notesTh: ['ยืนยันตัวตนกับรายชื่อผู้ติดต่อแล้ว ปลดล็อกบัญชีและออกลิงก์ใหม่'],
    asks: {
      en: [
        'For security we need to verify you. Please reply from your registered address and tell us the last four characters of your workspace id.',
      ],
      th: [
        'เพื่อความปลอดภัย ขอให้ตอบกลับจากอีเมลที่ลงทะเบียนไว้ และแจ้งอักขระ 4 ตัวท้ายของ workspace id ด้วยครับ',
      ],
    },
  },
  billing_report: {
    openings: {
      en: [
        {
          subject: 'Invoice for {month} shows unexpected usage',
          body: 'Hello,\n\nThe {month} invoice lists {n} extra API calls compared with last month, but our traffic did not change. Can you share the daily usage breakdown? Reference {ref}.',
        },
        {
          subject: 'Need the usage report for {month}',
          body: 'Hi team,\n\nFinance needs the monthly usage report for {month} as a CSV for our audit. Could you generate it for all workspaces?',
        },
        {
          subject: 'Request to correct the billing address',
          body: 'Hello,\n\nPlease update the billing address and tax details on invoices from {month}. New details are in the attached note. Reference {ref}.',
        },
      ],
      th: [
        {
          subject: 'ใบแจ้งหนี้เดือน {month} มียอดใช้งานเกินคาด',
          body: 'สวัสดีครับ\n\nใบแจ้งหนี้เดือน {month} มี API call เพิ่มมา {n} ครั้งเมื่อเทียบเดือนก่อน ทั้งที่ทราฟฟิกของเราไม่ได้เปลี่ยน ขอรายละเอียดการใช้งานรายวันได้ไหมครับ อ้างอิง {ref}',
        },
        {
          subject: 'ขอรายงานการใช้งานประจำเดือน {month}',
          body: 'สวัสดีค่ะ\n\nฝ่ายการเงินต้องการรายงานการใช้งานเดือน {month} เป็นไฟล์ CSV เพื่อใช้ตรวจสอบภายใน รบกวนออกให้ทุก workspace ได้ไหมคะ',
        },
        {
          subject: 'ขอแก้ไขที่อยู่ออกใบกำกับภาษี',
          body: 'สวัสดีครับ\n\nรบกวนแก้ไขที่อยู่และข้อมูลภาษีในใบแจ้งหนี้ตั้งแต่เดือน {month} รายละเอียดใหม่อยู่ในไฟล์แนบ อ้างอิง {ref}',
        },
      ],
    },
    resolutions: {
      en: [
        'We compared the daily usage: {n} calls came from a retry loop after the incident on the 12th, which our billing counted. We issued a credit note for that amount and attached the daily breakdown CSV. Please see "Invoices and billing" for how retries are counted.',
        'The report for {month} (all workspaces, CSV) is attached. The billing details were updated and the corrected invoices will be re-issued within two business days.',
      ],
      th: [
        'เราเทียบการใช้งานรายวันแล้ว พบว่า {n} ครั้งมาจาก retry loop หลังเหตุการณ์ในวันที่ 12 ซึ่งระบบคิดเงินนับรวมไว้ เราออกใบลดหนี้ตามจำนวนดังกล่าวและแนบไฟล์ CSV รายวันให้แล้วครับ',
        'แนบรายงานเดือน {month} (ทุก workspace เป็น CSV) แล้วค่ะ ข้อมูลใบกำกับภาษีแก้ไขเรียบร้อย และจะออกใบแจ้งหนี้ฉบับแก้ไขภายใน 2 วันทำการค่ะ',
      ],
    },
    notes: [
      'Usage export checked against billing ledger; difference matches the retry storm from the incident window.',
      'Credit note approved by the billing lead; finance to re-issue the invoice.',
    ],
    notesTh: ['ตรวจ ledger แล้ว ผลต่างตรงกับช่วงที่ retry พุ่ง ขอให้ lead อนุมัติใบลดหนี้'],
    asks: {
      en: ['Which invoice number and which workspaces should we compare?'],
      th: ['รบกวนระบุเลขที่ใบแจ้งหนี้และ workspace ที่ต้องการให้เทียบครับ'],
    },
  },
  feature_question: {
    openings: {
      en: [
        {
          subject: 'Can we export reports on a schedule?',
          body: 'Hello,\n\nIs it possible to schedule the {entity} report to be emailed every Monday morning? If not, is there an API we can call from our own scheduler?',
        },
        {
          subject: 'How do I set up role-based access for my team?',
          body: 'Hi,\n\nWe want read-only access for our auditors and edit access for operations. How do we configure roles in the workspace?',
        },
        {
          subject: 'Question about data retention',
          body: 'Hello,\n\nHow long do you keep {entity} data, and can we change the retention period? Our compliance team asks.',
        },
      ],
      th: [
        {
          subject: 'ตั้งเวลาส่งรายงานอัตโนมัติได้ไหม',
          body: 'สวัสดีครับ\n\nสามารถตั้งให้ส่งรายงาน{entity}ทางอีเมลทุกเช้าวันจันทร์ได้ไหมครับ ถ้าไม่ได้มี API ให้เรียกจาก scheduler ของเราเองไหม',
        },
        {
          subject: 'ตั้งค่าสิทธิ์ตามบทบาทให้ทีมอย่างไร',
          body: 'สวัสดีค่ะ\n\nต้องการให้ผู้ตรวจสอบดูได้อย่างเดียว ส่วนทีมปฏิบัติการแก้ไขได้ ต้องตั้งค่า role ใน workspace อย่างไรคะ',
        },
        {
          subject: 'สอบถามระยะเวลาเก็บข้อมูล',
          body: 'สวัสดีครับ\n\nระบบเก็บข้อมูล{entity}นานแค่ไหน และปรับระยะเวลาเก็บได้ไหมครับ ทีม compliance สอบถามมา',
        },
      ],
    },
    resolutions: {
      en: [
        'Scheduled exports are not available yet, but the reports API supports CSV and you can call it from your scheduler; I included an example in the guide below. I also registered your request on our roadmap.',
        'Roles are configured under Settings > Members. Choose "Viewer" for auditors and "Operator" for your operations team. Retention defaults to 13 months and can be shortened by an administrator.',
      ],
      th: [
        'ตอนนี้ยังตั้งเวลาส่งรายงานอัตโนมัติไม่ได้ แต่ reports API รองรับ CSV เรียกจาก scheduler ของคุณได้ ตัวอย่างอยู่ในคู่มือด้านล่าง และเราบันทึกคำขอไว้ใน roadmap แล้วครับ',
        'ตั้งค่า role ได้ที่ Settings > Members เลือก "Viewer" สำหรับผู้ตรวจสอบและ "Operator" สำหรับทีมปฏิบัติการ ระยะเก็บข้อมูลตั้งต้น 13 เดือน และผู้ดูแลสามารถปรับให้สั้นลงได้ค่ะ',
      ],
    },
    notes: ['Answered from the KB; no engineering work needed. Logged a feature request.'],
    notesTh: ['ตอบจาก KB ได้เลย ไม่ต้องใช้ dev บันทึก feature request ไว้แล้ว'],
    asks: {
      en: ['Which report and which format do you need?'],
      th: ['ต้องการรายงานไหน และรูปแบบไฟล์อะไรครับ'],
    },
  },
  workspace_config: {
    openings: {
      en: [
        {
          subject: 'Change the notification email of our workspace',
          body: 'Hello,\n\nPlease change the alert email for our workspace to the new shared address. Also we want to add a second webhook for the {env} environment.',
        },
        {
          subject: 'Enable the sandbox for a new project',
          body: 'Hi,\n\nWe are starting a new project and need a sandbox workspace with the same settings as production. Can you set it up? Reference {ref}.',
        },
        {
          subject: 'Rate limit increase for the {env} key',
          body: 'Hello team,\n\nWe expect {n}x more traffic next week because of a campaign. Please raise the rate limit of our {env} key until the end of the month.',
        },
      ],
      th: [
        {
          subject: 'ขอเปลี่ยนอีเมลแจ้งเตือนของ workspace',
          body: 'สวัสดีครับ\n\nรบกวนเปลี่ยนอีเมลสำหรับแจ้งเตือนของ workspace เป็นอีเมลกลางใหม่ และต้องการเพิ่ม webhook ตัวที่สองสำหรับ {env} ด้วยครับ',
        },
        {
          subject: 'ขอเปิด sandbox สำหรับโปรเจกต์ใหม่',
          body: 'สวัสดีค่ะ\n\nกำลังเริ่มโปรเจกต์ใหม่ ต้องการ sandbox workspace ที่ตั้งค่าเหมือน production รบกวนตั้งให้ได้ไหมคะ อ้างอิง {ref}',
        },
        {
          subject: 'ขอเพิ่ม rate limit ของ key {env}',
          body: 'สวัสดีครับ\n\nสัปดาห์หน้ามีแคมเปญ คาดว่าทราฟฟิกจะเพิ่มขึ้น {n} เท่า ขอเพิ่ม rate limit ของ key {env} ไปจนสิ้นเดือนครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'Done: the alert email was updated, the second webhook is registered and a test event was delivered successfully. Please confirm on your side.',
        'The sandbox workspace is ready with the same settings as production (no production data). We raised the rate limit of the {env} key until the end of the month and will revert it automatically.',
      ],
      th: [
        'เรียบร้อยครับ เปลี่ยนอีเมลแจ้งเตือน เพิ่ม webhook ตัวที่สอง และทดสอบส่ง event สำเร็จแล้ว รบกวนยืนยันทางฝั่งคุณอีกครั้งนะครับ',
        'sandbox workspace พร้อมใช้งานแล้วค่ะ ตั้งค่าเหมือน production (ไม่มีข้อมูลจริง) และเราเพิ่ม rate limit ของ key {env} ไปจนสิ้นเดือน แล้วจะปรับกลับให้อัตโนมัติค่ะ',
      ],
    },
    notes: [
      'Change applied by an admin through the console and verified with a test event. Change logged on the org notes.',
    ],
    notesTh: ['ตั้งค่าผ่าน console แล้วทดสอบ event ผ่าน บันทึกลง notes ของ org'],
    asks: {
      en: ['Please confirm the new address and the event types the second webhook should receive.'],
      th: ['รบกวนยืนยันอีเมลใหม่ และประเภท event ที่ webhook ตัวที่สองควรได้รับครับ'],
    },
  },
  result_dispute: {
    openings: {
      en: [
        {
          subject: 'Settlement total does not match our records',
          body: 'Hello,\n\nThe settlement report for {month} shows a total that is {n} lower than our own records for {entity} {ref}. Please re-check the calculation.',
        },
        {
          subject: 'Wrong status for {entity} {ref}',
          body: 'Hi,\n\n{entity} {ref} is marked as "rejected" in your system, but our customer completed it at {when}. We need the status corrected today.',
        },
        {
          subject: 'Duplicate charges on {entity}',
          body: 'Hello,\n\nWe see two entries for {entity} {ref} in the result list and the customer was charged twice. Can you verify?',
        },
      ],
      th: [
        {
          subject: 'ยอดสรุปไม่ตรงกับบันทึกของเรา',
          body: 'สวัสดีครับ\n\nรายงานสรุปเดือน {month} มียอดต่ำกว่าบันทึกของเรา {n} บาทสำหรับ{entity} {ref} รบกวนตรวจสอบการคำนวณอีกครั้งครับ',
        },
        {
          subject: 'สถานะ{entity} {ref} ไม่ถูกต้อง',
          body: 'สวัสดีค่ะ\n\n{entity} {ref} ขึ้นสถานะ "rejected" แต่ลูกค้าของเราทำรายการสำเร็จเมื่อ {when} ต้องการให้แก้สถานะภายในวันนี้ค่ะ',
        },
        {
          subject: 'รายการ{entity}ซ้ำ ลูกค้าถูกตัดเงินสองครั้ง',
          body: 'สวัสดีครับ\n\nพบรายการ{entity} {ref} ซ้ำสองรายการในรายการผลลัพธ์ และลูกค้าถูกตัดเงินสองครั้ง ช่วยตรวจสอบหน่อยครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'We re-ran the calculation with the corrected rounding rule and the report now matches your records; the corrected file is attached. The earlier difference came from rounding per line instead of per document.',
        'The duplicate entry was created by a retry that arrived after a timeout. We removed the duplicate and refunded the second charge; it should appear within 3 business days. We also added an idempotency check for this flow.',
      ],
      th: [
        'เราคำนวณใหม่ด้วยกฎการปัดเศษที่แก้ไขแล้ว รายงานตรงกับบันทึกของคุณ แนบไฟล์ฉบับแก้ไขให้แล้วครับ ผลต่างเดิมเกิดจากการปัดเศษรายบรรทัดแทนที่จะปัดรายเอกสาร',
        'รายการซ้ำเกิดจาก retry ที่เข้ามาหลัง timeout ค่ะ เราลบรายการซ้ำและคืนเงินรายการที่สอง จะเห็นยอดคืนภายใน 3 วันทำการ และเพิ่ม idempotency check ใน flow นี้แล้วค่ะ',
      ],
    },
    notes: [
      'Compared the two exports line by line: the difference is a rounding rule, not missing records.',
      'Duplicate confirmed from the audit trail. Refund requested through the payment partner; waiting for confirmation.',
    ],
    notesTh: ['เทียบข้อมูลแล้ว ผลต่างมาจากการปัดเศษ ไม่ใช่ข้อมูลหาย'],
    asks: {
      en: ['Could you send both totals and the document numbers you compared?'],
      th: ['ขอยอดทั้งสองฝั่งและเลขที่เอกสารที่เทียบกันได้ไหมครับ'],
    },
  },
  incident_inquiry: {
    openings: {
      en: [
        {
          subject: 'Is there an outage right now?',
          body: 'Hello,\n\nMany of our users report that the application is not loading since {when}. Is this a known incident? What is the estimated time to recovery?',
        },
        {
          subject: 'Request for the incident report',
          body: 'Hi team,\n\nCould you share the post-incident summary for the disruption on {month}? Our management asks for the root cause and what you changed.',
        },
        {
          subject: 'Status page says operational but we have errors',
          body: 'Hello,\n\nYour status page shows everything operational, yet we get errors on {endpoint}. Request id {ref}. Are you aware?',
        },
      ],
      th: [
        {
          subject: 'ตอนนี้ระบบล่มอยู่หรือเปล่า',
          body: 'สวัสดีครับ\n\nผู้ใช้ของเราหลายคนแจ้งว่าแอปโหลดไม่ขึ้นตั้งแต่ {when} เป็นเหตุการณ์ที่ทราบอยู่แล้วหรือไม่ และคาดว่าจะกลับมาเมื่อไรครับ',
        },
        {
          subject: 'ขอรายงานสรุปเหตุการณ์ที่เกิดขึ้น',
          body: 'สวัสดีค่ะ\n\nขอสรุปเหตุการณ์ระบบขัดข้องเมื่อ {month} ผู้บริหารต้องการทราบสาเหตุและสิ่งที่แก้ไขค่ะ',
        },
        {
          subject: 'หน้า status ขึ้นปกติแต่เรายังเจอ error',
          body: 'สวัสดีครับ\n\nหน้า status แสดงว่าทุกอย่างปกติ แต่เรายังเจอ error ที่ {endpoint} request id {ref} ทราบเรื่องนี้หรือยังครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'Yes, we are aware: this is part of our active incident and the status page has been updated. We will post updates every 30 minutes. A recovery is expected within the hour; I will write again once monitoring is green.',
        'Attached is the post-incident summary: timeline, root cause, customer impact and the follow-up actions with owners. Please tell us if management needs a call to walk through it.',
      ],
      th: [
        'ทราบเรื่องแล้วครับ เป็นส่วนหนึ่งของ incident ที่กำลังดำเนินการ และอัปเดตหน้า status แล้ว เราจะแจ้งความคืบหน้าทุก 30 นาที คาดว่าจะกลับมาปกติภายในหนึ่งชั่วโมง และจะแจ้งอีกครั้งเมื่อ monitoring เป็นปกติ',
        'แนบสรุปเหตุการณ์ฉบับสมบูรณ์ค่ะ ประกอบด้วย timeline สาเหตุ ผลกระทบต่อลูกค้า และงานติดตามพร้อมผู้รับผิดชอบ หากผู้บริหารต้องการให้อธิบายทางโทรศัพท์แจ้งได้เลยค่ะ',
      ],
    },
    notes: [
      'Linked to the active incident; sent the approved holding statement. Customer comms go through the incident page, not ad-hoc replies.',
    ],
    notesTh: ['ผูกกับ incident ที่เปิดอยู่ ใช้ข้อความ holding statement ที่อนุมัติแล้ว'],
    asks: {
      en: ['Which feature or page is affected, and since when exactly?'],
      th: ['ฟีเจอร์หรือหน้าไหนที่ได้รับผลกระทบ และเริ่มเมื่อไรครับ'],
    },
  },
  other: {
    openings: {
      en: [
        {
          subject: 'Question about our contract renewal',
          body: 'Hello,\n\nOur contract renews next month. Who can we talk to about adjusting the plan and adding two more workspaces?',
        },
        {
          subject: 'Feedback on the new dashboard',
          body: 'Hi team,\n\nThe new dashboard is nicer, but we miss the old filter by status. Is it coming back?',
        },
        {
          subject: 'Request for a security questionnaire',
          body: 'Hello,\n\nOur security team would like to receive your standard security questionnaire answers and the latest penetration test summary.',
        },
      ],
      th: [
        {
          subject: 'สอบถามเรื่องการต่อสัญญา',
          body: 'สวัสดีครับ\n\nสัญญาของเราจะครบกำหนดเดือนหน้า ติดต่อใครได้บ้างเรื่องปรับแพ็กเกจและเพิ่ม workspace อีกสองตัวครับ',
        },
        {
          subject: 'ข้อเสนอแนะเกี่ยวกับ dashboard ใหม่',
          body: 'สวัสดีค่ะ\n\ndashboard ใหม่สวยขึ้น แต่คิดถึงตัวกรองตามสถานะแบบเดิม จะกลับมาไหมคะ',
        },
        {
          subject: 'ขอแบบสอบถามด้านความปลอดภัย',
          body: 'สวัสดีครับ\n\nทีมความปลอดภัยของเราขอคำตอบแบบสอบถามมาตรฐานและสรุปผลการทดสอบเจาะระบบล่าสุดครับ',
        },
      ],
    },
    resolutions: {
      en: [
        'Thank you. I have passed this to your account manager, who will contact you this week. I also attached the documents you asked for.',
        'Thanks for the feedback. The status filter is on our roadmap for next month; I added your vote. In the meantime you can use the saved view "My open items".',
      ],
      th: [
        'ขอบคุณครับ ส่งเรื่องต่อให้ account manager ของคุณแล้ว จะติดต่อกลับภายในสัปดาห์นี้ และแนบเอกสารที่ขอมาให้แล้วครับ',
        'ขอบคุณสำหรับข้อเสนอแนะค่ะ ตัวกรองตามสถานะอยู่ใน roadmap เดือนหน้า เราบันทึกโหวตของคุณไว้แล้ว ระหว่างนี้ใช้ saved view "My open items" ไปก่อนได้ค่ะ',
      ],
    },
    notes: ['Not a technical issue; routed to the account manager and noted on the org.'],
    notesTh: ['ไม่ใช่เรื่องเทคนิค ส่งต่อ account manager'],
    asks: {
      en: ['Could you tell us more about what you need?'],
      th: ['ช่วยเล่ารายละเอียดเพิ่มเติมได้ไหมครับ'],
    },
  },
};

export interface GenericText {
  readonly agentAck: readonly string[];
  readonly agentAsk: readonly string[];
  readonly agentUpdate: readonly string[];
  readonly agentClose: readonly string[];
  readonly customerInfo: readonly string[];
  /** The same answers when a screenshot is attached to the message. */
  readonly customerInfoShot: readonly string[];
  readonly customerNudge: readonly string[];
  readonly customerThanks: readonly string[];
  readonly customerReopen: readonly string[];
  readonly greeting: (name: string) => string;
  readonly regards: string;
}

export const GENERIC: Record<Lang, GenericText> = {
  en: {
    agentAck: [
      'Thank you for contacting us. I have received your request and I am looking into it now.',
      'Thanks for the details. We are investigating and will come back with an update as soon as we know more.',
      'We have received your report and assigned it to our team. I will update you here shortly.',
    ],
    agentAsk: [
      'To continue I need a little more information, please see the questions below.',
      'Thanks. Before I can confirm the cause, could you help with the following?',
    ],
    agentUpdate: [
      'A quick update: we have narrowed it down and are working on a fix. I will confirm as soon as it is done.',
      'Still investigating. Our developers are looking at the logs for the time window you mentioned.',
      'Update: the change is being tested. We expect to finish by end of day.',
    ],
    agentClose: [
      'I am marking this as resolved. If anything still looks wrong, just reply here and we will reopen it.',
      'Please let us know if this works for you. The ticket stays open for a few days in case you need more help.',
    ],
    customerInfo: [
      'Thanks for the quick reply. Here is the information you asked for.',
      'Sure, details below. It happens every time and only in the {env} environment.',
      'Here are the examples. Request id {ref} is the latest one; the earlier ones look the same.',
    ],
    customerInfoShot: [
      'Thanks for the quick reply. Here is the information you asked for. I attached a screenshot of the error.',
      'Sure, see the screenshot. It happens every time and only in the {env} environment.',
      'Attached is what we see on screen. Request id {ref} is the latest one; the earlier ones look the same.',
    ],
    customerNudge: [
      'Any update on this? Our team is waiting for it.',
      'Following up, this is still affecting us. Could you let us know the status?',
    ],
    customerThanks: [
      'Thank you, it works now.',
      'Confirmed, everything looks fine on our side. Thanks for the quick help!',
      'Great, thanks for the explanation. You can close the ticket.',
    ],
    customerReopen: [
      'Unfortunately it happened again this morning. Request id {ref}.',
      'The problem is back after the weekend. Can you take another look?',
    ],
    greeting: (name) => `Hi ${name.split(' ')[0] ?? name},`,
    regards: 'Best regards,',
  },
  th: {
    agentAck: [
      'ขอบคุณที่ติดต่อมาครับ ได้รับเรื่องแล้วและกำลังตรวจสอบให้ทันที',
      'ขอบคุณสำหรับรายละเอียดค่ะ ทีมกำลังตรวจสอบ และจะแจ้งความคืบหน้าให้ทราบโดยเร็วที่สุด',
      'ได้รับเรื่องและมอบหมายให้ทีมที่เกี่ยวข้องแล้วครับ จะอัปเดตที่นี่ในอีกสักครู่',
    ],
    agentAsk: [
      'เพื่อตรวจสอบต่อ ขอข้อมูลเพิ่มเติมตามด้านล่างครับ',
      'ขอบคุณค่ะ ก่อนยืนยันสาเหตุ รบกวนช่วยตอบคำถามต่อไปนี้ด้วยนะคะ',
    ],
    agentUpdate: [
      'อัปเดตความคืบหน้าครับ ตอนนี้ระบุสาเหตุได้แล้วและกำลังแก้ไข จะแจ้งทันทีเมื่อเสร็จ',
      'ยังอยู่ระหว่างตรวจสอบค่ะ นักพัฒนากำลังดู log ในช่วงเวลาที่แจ้งมา',
      'อัปเดตครับ: การแก้ไขอยู่ระหว่างทดสอบ คาดว่าเสร็จภายในสิ้นวันนี้',
    ],
    agentClose: [
      'ขอปิดเรื่องนี้เป็น resolved นะครับ หากยังพบความผิดปกติ ตอบกลับในเธรดนี้ได้เลย เราจะเปิดเรื่องใหม่ให้',
      'รบกวนแจ้งผลหลังลองใช้งานค่ะ ตั๋วนี้จะเปิดค้างไว้อีกสองสามวันเผื่อต้องการความช่วยเหลือเพิ่ม',
    ],
    customerInfo: [
      'ขอบคุณที่ตอบเร็วครับ ข้อมูลตามที่ขอ',
      'ได้ค่ะ รายละเอียดด้านล่าง เกิดทุกครั้ง และเกิดเฉพาะบน {env}',
      'ตัวอย่างตามนี้ครับ request id {ref} เป็นครั้งล่าสุด ครั้งก่อนหน้าก็ลักษณะเดียวกัน',
    ],
    customerInfoShot: [
      'ขอบคุณที่ตอบเร็วครับ ข้อมูลตามที่ขอ แนบภาพหน้าจอ error มาด้วยแล้ว',
      'ได้ค่ะ ดูตามภาพหน้าจอที่แนบ เกิดทุกครั้ง และเกิดเฉพาะบน {env}',
      'แนบภาพที่เห็นบนหน้าจอมาด้วยครับ request id {ref} เป็นครั้งล่าสุด ครั้งก่อนหน้าก็ลักษณะเดียวกัน',
    ],
    customerNudge: [
      'มีความคืบหน้าหรือยังครับ ทีมเรารออยู่',
      'ติดตามเรื่องนี้ค่ะ ยังได้รับผลกระทบอยู่ รบกวนแจ้งสถานะด้วยค่ะ',
    ],
    customerThanks: [
      'ขอบคุณครับ ใช้งานได้แล้ว',
      'ยืนยันค่ะ ทุกอย่างปกติแล้ว ขอบคุณที่ช่วยเร็วมาก',
      'เข้าใจแล้วครับ ขอบคุณสำหรับคำอธิบาย ปิดเรื่องได้เลยครับ',
    ],
    customerReopen: [
      'เช้านี้เกิดอีกแล้วครับ request id {ref}',
      'หลังวันหยุดปัญหากลับมาอีกค่ะ ช่วยตรวจดูอีกครั้งได้ไหมคะ',
    ],
    greeting: (name) => `สวัสดีครับ/ค่ะ คุณ ${name.split(' ')[0] ?? name}`,
    regards: 'ด้วยความเคารพ',
  },
};

const ENTITIES_EN = [
  'order sync',
  'invoice export',
  'shipment',
  'payment',
  'inventory update',
  'booking',
  'report',
  'customer record',
];
const ENTITIES_TH = [
  'การซิงก์ออเดอร์',
  'การส่งออกใบแจ้งหนี้',
  'พัสดุ',
  'การชำระเงิน',
  'การอัปเดตสต็อก',
  'การจอง',
  'รายงาน',
  'ข้อมูลลูกค้า',
];
const ENDPOINTS = [
  '/v2/orders',
  '/v2/orders/sync',
  '/v2/shipments',
  '/v1/payments/confirm',
  '/v2/inventory/items',
  '/v2/bookings',
  '/v1/reports/export',
  '/v2/customers',
  '/v1/rates/lookup',
  '/v2/webhooks/test',
];
const CODES = [
  'E1042',
  'ERR_VALIDATION_422',
  'E2007',
  'AUTH_TOKEN_EXPIRED',
  'E5013',
  'RATE_LIMIT_429',
  'E3301',
];
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS_TH = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

export interface FillContext {
  readonly lang: Lang;
  readonly rng: Rng;
  /** Bangkok wall-clock `HH:MM` of the ticket's creation. */
  readonly whenLabel: string;
  readonly monthIndex: number;
  readonly userEmail: string;
}

export function makeVars(context: FillContext): Record<string, string> {
  const { rng, lang } = context;
  return {
    ref: `req_${rng.hex(8)}`,
    code: rng.pick(CODES),
    endpoint: rng.pick(ENDPOINTS),
    when: context.whenLabel,
    env: rng.pick(['production', 'production', 'production', 'staging']),
    n: String(rng.pick([2, 3, 5, 8, 12, 17, 24, 38, 61, 120, 340])),
    entity: lang === 'th' ? rng.pick(ENTITIES_TH) : rng.pick(ENTITIES_EN),
    month: (lang === 'th' ? MONTHS_TH : MONTHS_EN)[context.monthIndex] ?? '',
    user: context.userEmail,
  };
}

export function fillText(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

export const TABLE_HEADERS: Record<Lang, readonly string[]> = {
  en: ['Time (UTC+7)', 'Endpoint', 'Status', 'Request id'],
  th: ['เวลา (UTC+7)', 'Endpoint', 'สถานะ', 'Request id'],
};

/** A few rows of failing calls for the "table in an email" case. */
export function failingRows(
  rng: Rng,
  endpointVars: Readonly<Record<string, string>>,
  atHour: number,
): string[][] {
  const count = rng.int(3, 5);
  return Array.from({ length: count }, (_, index) => [
    `${String(atHour).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:${String(
      rng.int(0, 59),
    ).padStart(2, '0')}`,
    endpointVars.endpoint ?? '/v2/orders',
    rng.pick(['500', '502', '504', '422']),
    index === 0 ? (endpointVars.ref ?? `req_${rng.hex(8)}`) : `req_${rng.hex(8)}`,
  ]);
}
