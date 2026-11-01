import type { rolesEn } from '../en/roles';
import type { Widen } from '../types';

export const rolesTh: Widen<typeof rolesEn> = {
  agent: 'เจ้าหน้าที่',
  lead: 'หัวหน้าทีม',
  head: 'ผู้จัดการ',
  client: 'ลูกค้า',
  system: 'ระบบ',
};
