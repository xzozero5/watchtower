import type { otherMailEn } from '../en/otherMail';
import type { Widen } from '../types';

/** Thai copy of Other mail. Same keys as en/otherMail.ts. */
export const otherMailTh: Widen<typeof otherMailEn> = {
  title: 'อีเมลอื่น ๆ',
  intro:
    'ข้อความที่ไม่ได้กลายเป็น ticket เช่น จดหมายข่าว ข้อความตอบกลับอัตโนมัติ และเมลภายในหรือจากระบบ หากข้อความไหนเป็นคำขอจริง ให้เปลี่ยนเป็น ticket',
  listLabel: 'ข้อความ',
  loading: 'กำลังโหลดข้อความ',
  loadMore: 'โหลดข้อความเพิ่ม',
  loadingMore: 'กำลังโหลดข้อความเพิ่ม',
  search: { label: 'ค้นหาอีเมลอื่น ๆ', placeholder: 'ค้นหาจากผู้ส่ง หัวเรื่อง หรือเนื้อหา' },
  filter: {
    label: 'แสดง',
    all: 'ทั้งหมด',
    noise: 'ขยะ',
    auto_reply: 'ตอบกลับอัตโนมัติ',
    internal: 'ภายในและจากระบบ',
  },
  kind: {
    noise: 'ขยะ',
    auto_reply: 'ตอบกลับอัตโนมัติ',
    internal: 'ภายในหรือจากระบบ',
  },
  empty: { title: 'ยังไม่มีอะไร', body: 'ไม่มีข้อความที่รอตรวจในรายการนี้' },
  emptyFiltered: { title: 'ไม่มีข้อความที่ตรงกัน', body: 'ลองเปลี่ยนตัวกรองหรือใช้คำอื่น' },
  error: {
    title: 'โหลดอีเมลอื่น ๆ ไม่สำเร็จ',
    body: 'ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
  },
  noSubject: '(ไม่มีหัวเรื่อง)',
  unknownSender: 'ไม่ทราบผู้ส่ง',
  fromLine: 'จาก {sender}',
  receivedAt: 'ได้รับเมื่อ',
  attachments: 'ไฟล์แนบ {count} ไฟล์',
  why: 'ทำไมจึงอยู่ที่นี่',
  reasonRules: 'หัวเมลระบุว่าเป็นข้อความอัตโนมัติ ({subtype})',
  classified: 'จัดเป็น {type} มั่นใจ {confidence}% ({source})',
  classifiedNoConfidence: 'จัดเป็น {type} ({source})',
  sourceAi: 'AI',
  sourceRules: 'กฎ',
  noReason: 'ไม่ได้บันทึกเหตุผลไว้',
  select: 'เลือกข้อความเพื่ออ่าน',
  detailLabel: 'ข้อความ',
  body: 'เนื้อหาของข้อความ',
  bodyEmpty: '(ไม่มีเนื้อหา)',
  convert: 'นี่คือ ticket',
  converting: 'กำลังเปิด ticket…',
  convertHint: 'เปิด ticket จากข้อความนี้ ระบบจะไม่ส่งอะไรถึงผู้ส่ง แม้แต่ข้อความรับทราบ',
  converted: 'เปิด ticket {key} จากข้อความนี้แล้ว',
  openTicket: 'เปิด {key}',
  convertFailed: 'เปิด ticket ไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
  convertErrors: {
    conflict: 'ข้อความนี้เปลี่ยนเป็น ticket ไม่ได้ (เป็น ticket อยู่แล้ว หรือองค์กรถูกปิดใช้งาน)',
    not_found: 'ไม่พบข้อความนี้แล้ว',
    forbidden: 'คุณไม่มีสิทธิ์เปิด ticket',
  },
  denied: {
    title: 'คุณใช้อีเมลอื่น ๆ ไม่ได้',
    body: 'หากต้องการอ่านข้อความที่ไม่ได้กลายเป็น ticket ให้ถามหัวหน้าทีม',
  },
};
