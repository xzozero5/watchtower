import type { Messages } from './en';

/** Thai UI copy. Same keys as en.ts. */
export const th: Messages = {
  app: {
    name: 'Watchtower',
    description: 'ศูนย์ปฏิบัติการสำหรับทีม Tech Operations',
    skipToContent: 'ข้ามไปยังบทสนทนา',
  },
  topbar: {
    openPalette: 'เปิดแผงคำสั่ง',
    preferences: 'การแสดงผลและภาษา',
  },
  panes: {
    queue: {
      title: 'คิวงาน',
      emptyTitle: 'ยังไม่มี ticket',
      emptyBody: 'ticket ใหม่จากทุกช่องทางจะแสดงที่นี่ เรียงจากเร่งด่วนที่สุด',
    },
    conversation: {
      title: 'บทสนทนา',
      emptyTitle: 'เลือก ticket',
      emptyBody: 'เลือก ticket จากคิวงานเพื่ออ่านบทสนทนาและตอบกลับ',
    },
    assistant: {
      title: 'ผู้ช่วย AI',
      emptyTitle: 'ยังไม่มีอะไรให้ตรวจสอบ',
      emptyBody: 'เปิด ticket แล้วรายงาน หลักฐาน และร่างคำตอบจะแสดงที่นี่ให้คุณตรวจ',
    },
  },
  severity: {
    p1: 'วิกฤต',
    p2: 'สูง',
    p3: 'ปานกลาง',
    p4: 'ต่ำ',
    keyTitle: 'ความหมายของระดับความรุนแรง',
    keyHint: 'ทุกระดับมีไอคอนและป้ายชื่อของตัวเอง ไม่ได้แยกด้วยสีอย่างเดียว',
  },
  palette: {
    title: 'แผงคำสั่ง',
    description: 'พิมพ์เพื่อกรองคำสั่ง ใช้ปุ่มลูกศรเลื่อน และกด Enter เพื่อสั่งงาน',
    placeholder: 'พิมพ์คำสั่ง',
    listLabel: 'คำสั่ง',
    empty: 'ไม่พบคำสั่งที่ตรงกัน',
    emptyHint: 'ลองคำอื่น เช่น "ธีม" หรือ "ภาษา"',
    groups: {
      display: 'การแสดงผล',
      language: 'ภาษา',
    },
  },
  commands: {
    themeSystem: 'ธีม: ตามระบบ',
    themeLight: 'ธีม: สว่าง',
    themeDark: 'ธีม: มืด',
    densityComfortable: 'ความหนาแน่น: สบายตา',
    densityCompact: 'ความหนาแน่น: กะทัดรัด',
    languageEnglish: 'ภาษา: English',
    languageThai: 'ภาษา: ไทย',
  },
  prefs: {
    theme: { label: 'ธีม', system: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' },
    density: { label: 'ความหนาแน่น', comfortable: 'สบายตา', compact: 'กะทัดรัด' },
    language: { label: 'ภาษา' },
  },
  apiStatus: {
    label: 'สถานะ API',
    checking: 'กำลังตรวจสอบ API',
    online: 'API ทำงานปกติ',
    offline: 'เชื่อมต่อ API ไม่ได้',
  },
  loading: {
    label: 'กำลังโหลด',
  },
  errors: {
    title: 'เกิดข้อผิดพลาด',
    body: 'ไม่สามารถแสดงหน้านี้ได้ งานของคุณไม่ได้ถูกเปลี่ยนแปลง ลองอีกครั้ง',
    retry: 'ลองอีกครั้ง',
    notFoundTitle: 'ไม่พบหน้านี้',
    notFoundBody: 'หน้านี้ไม่มีอยู่หรือถูกย้ายแล้ว',
    backHome: 'กลับไปที่คิวงาน',
  },
};
