import type { liveEn } from '../en/live';
import type { Widen } from '../types';

export const liveTh: Widen<typeof liveEn> = {
  label: 'การอัปเดตสด',
  open: 'สด',
  connecting: 'กำลังเชื่อมต่อ',
  reconnecting: 'กำลังเชื่อมต่อใหม่',
  paused: 'หยุดอัปเดตสดในแท็บนี้',
  forbidden: 'ไม่มีการอัปเดตสด',
  ended: 'ออกจากระบบแล้ว',
  retry: 'เชื่อมต่อใหม่',
};
