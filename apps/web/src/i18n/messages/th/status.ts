import type { statusEn } from '../en/status';
import type { Widen } from '../types';

export const statusTh: Widen<typeof statusEn> = {
  new: 'ใหม่',
  triage: 'คัดแยก',
  open: 'เปิดอยู่',
  waitingOnCustomer: 'รอลูกค้า',
  waitingOnDev: 'รอทีมพัฒนา',
  resolved: 'แก้ไขแล้ว',
  closed: 'ปิดแล้ว',
  merged: 'รวมแล้ว',
};
