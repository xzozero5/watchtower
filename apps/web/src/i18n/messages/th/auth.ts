import type { authEn } from '../en/auth';
import type { Widen } from '../types';

export const authTh: Widen<typeof authEn> = {
  gate: {
    loading: 'กำลังตรวจสอบเซสชันของคุณ',
    errorTitle: 'ตรวจสอบเซสชันของคุณไม่ได้',
    errorBody: 'เชื่อมต่อ API ไม่ได้ งานของคุณไม่ได้ถูกเปลี่ยนแปลง ลองอีกครั้ง',
  },
};
