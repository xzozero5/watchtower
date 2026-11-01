import type { panesEn } from '../en/panes';
import type { Widen } from '../types';

export const panesTh: Widen<typeof panesEn> = {
  queue: {
    title: 'คิวงาน',
    emptyTitle: 'ไม่มีงานค้างแล้ว',
  },
  conversation: {
    title: 'บทสนทนา',
    emptyTitle: 'เลือก ticket',
  },
  assistant: {
    title: 'รายละเอียดและ AI',
  },
};
