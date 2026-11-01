import type { apiStatusEn } from '../en/apiStatus';
import type { Widen } from '../types';

export const apiStatusTh: Widen<typeof apiStatusEn> = {
  label: 'สถานะ API',
  checking: 'กำลังตรวจสอบ API',
  online: 'API ทำงานปกติ',
  offline: 'เชื่อมต่อ API ไม่ได้',
};
