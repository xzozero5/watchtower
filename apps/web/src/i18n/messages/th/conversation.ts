import type { conversationEn } from '../en/conversation';
import type { Widen } from '../types';

export const conversationTh: Widen<typeof conversationEn> = {
  loading: 'กำลังโหลด ticket',
  loadingMessages: 'กำลังโหลดข้อความ',
  error: {
    title: 'โหลด ticket ไม่สำเร็จ',
    body: 'ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
  },
  notFound: {
    title: 'ไม่พบ ticket',
    body: 'ticket นี้ไม่มีอยู่ หรือคุณไม่มีสิทธิ์เข้าถึง',
  },
  timelineError: { title: 'โหลดข้อความไม่สำเร็จ' },
  noMessages: {
    title: 'ยังไม่มีข้อความ',
    body: 'ข้อความและคำตอบใน ticket นี้จะแสดงที่นี่',
  },
  headerActions: 'การดำเนินการของ ticket',
  copyKey: 'คัดลอกรหัส ticket',
  keyCopied: 'คัดลอก {key} แล้ว',
  resolve: 'แก้ไขแล้ว',
};
