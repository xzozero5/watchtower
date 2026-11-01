import type { bulkEn } from '../en/bulk';
import type { Widen } from '../types';

/** Thai copy of the bulk bar. Same keys as en/bulk.ts. */
export const bulkTh: Widen<typeof bulkEn> = {
  region: 'การดำเนินการกับ ticket ที่เลือก',
  selected: 'เลือกแล้ว {count} รายการ',
  clear: 'ล้างการเลือก',
  selectRow: 'เลือก {key}',
  assign: 'มอบหมาย',
  assignTo: 'มอบหมายให้…',
  assignToMe: 'ฉัน ({name})',
  unassign: 'ยังไม่มีผู้รับผิดชอบ',
  status: 'สถานะ',
  statusTo: 'เปลี่ยนสถานะเป็น…',
  priority: 'ความสำคัญ',
  priorityTo: 'เปลี่ยนความสำคัญเป็น…',
  merge: 'รวม…',
  mergeTitle: 'รวมเป็น ticket เดียว',
  mergeInto: 'ticket ที่จะเก็บไว้',
  mergeHint:
    'กรอกเลข ticket ที่จะเก็บไว้ เช่น {example} ticket ที่เลือกจะถูกรวมเข้าไปใน ticket นั้น',
  mergeSubmit: 'รวม {count} ticket',
  mergeCancel: 'ยกเลิก',
  apply: 'ดำเนินการ',
  working: 'กำลังดำเนินการ…',
  allDone: 'เรียบร้อย: เปลี่ยน {count} ticket แล้ว',
  oneDone: 'เรียบร้อย: เปลี่ยน 1 ticket แล้ว',
  partial: 'เปลี่ยนแล้ว {ok} รายการ เปลี่ยนไม่ได้ {failed} รายการ ซึ่งยังคงถูกเลือกอยู่',
  nothingChanged: 'ไม่มีอะไรถูกเปลี่ยนแปลง ticket ยังคงถูกเลือกอยู่',
  failedItem: '{key}: {reason}',
  failedUnknownKey: 'ticket ที่คุณเปิดไม่ได้: {reason}',
  requestFailed: 'ส่งการเปลี่ยนแปลงไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
  reasons: {
    ticket_not_open: 'ticket นี้ถูกรวมเข้ากับ ticket อื่นแล้ว',
    invalid_transition: 'ขั้นตอนงานไม่อนุญาตให้เปลี่ยนเป็นสถานะนี้จากสถานะปัจจุบัน',
    merge_not_allowed: 'รวม ticket เหล่านี้ไม่ได้ (คนละองค์กร หรือจะวนเป็นวง)',
    not_found: 'ไม่พบ ticket นี้แล้ว หรือคุณไม่มีสิทธิ์เปลี่ยน',
    forbidden: 'คุณไม่มีสิทธิ์เปลี่ยน ticket นี้',
    conflict: 'ticket ถูกเปลี่ยนไปก่อนหน้านี้',
    validation_failed: 'ไม่รับคำขอนี้',
    other: 'เปลี่ยนไม่สำเร็จ',
  },
};
