import type { slaEn } from '../en/sla';
import type { Widen } from '../types';

export const slaTh: Widen<typeof slaEn> = {
  firstResponse: 'ตอบแรก',
  resolution: 'แก้ไข',
  onTrack: '{target} {time}',
  atRisk: 'เหลือ {time}',
  breached: 'เกินกำหนด {time}',
  paused: 'หยุดนับ',
  met: 'ทันเวลา',
  none: 'ไม่มี SLA',
  due: {
    firstResponse: 'ครบกำหนดตอบแรก {at}',
    resolution: 'ครบกำหนดแก้ไข {at}',
  },
};
