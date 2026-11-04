import type { Messages } from '../en';
import { adminTh } from './admin';
import { attachmentsTh } from './attachments';
import { aiTh } from './ai';
import { aiOfflineTh } from './aiOffline';
import { assistantTh } from './assistant';
import { apiStatusTh } from './apiStatus';
import { appTh } from './app';
import { authTh } from './auth';
import { bulkTh } from './bulk';
import { channelTh } from './channel';
import { commandsTh } from './commands';
import { composerTh } from './composer';
import { emailTh } from './email';
import { conversationTh } from './conversation';
import { csatTh } from './csat';
import { customerTh } from './customer';
import { dashboardTh } from './dashboard';
import { reportsTh } from './reports';
import { detailsTh } from './details';
import { devHomeTh } from './devHome';
import { errorsTh } from './errors';
import { gradeTh } from './grade';
import { homeTh } from './home';
import { investigateTh } from './investigate';
import { keymapTh } from './keymap';
import { liveTh } from './live';
import { loadingTh } from './loading';
import { loginTh } from './login';
import { newTicketTh } from './newTicket';
import { notificationsTh } from './notifications';
import { otherMailTh } from './otherMail';
import { outboxAdminTh } from './outboxAdmin';
import { opsTh } from './ops';
import { outboundTh } from './outbound';
import { paletteTh } from './palette';
import { panelTh } from './panel';
import { panesTh } from './panes';
import { portalTh } from './portal';
import { prefsTh } from './prefs';
import { queueTh } from './queue';
import { railTh } from './rail';
import { rolesTh } from './roles';
import { severityTh } from './severity';
import { shiftTh } from './shift';
import { slaTh } from './sla';
import { statesTh } from './states';
import { statusTh } from './status';
import { timelineTh } from './timeline';
import { toastTh } from './toast';
import { topbarTh } from './topbar';
import { workspaceTh } from './workspace';

/** Thai UI copy, one file per namespace. Same keys as `../en`. */
export const th: Messages = {
  app: appTh,
  topbar: topbarTh,
  roles: rolesTh,
  channel: channelTh,
  status: statusTh,
  panes: panesTh,
  queue: queueTh,
  conversation: conversationTh,
  timeline: timelineTh,
  composer: composerTh,
  attachments: attachmentsTh,
  email: emailTh,
  details: detailsTh,
  sla: slaTh,
  workspace: workspaceTh,
  ai: aiTh,
  aiOffline: aiOfflineTh,
  assistant: assistantTh,
  live: liveTh,
  keymap: keymapTh,
  auth: authTh,
  login: loginTh,
  severity: severityTh,
  palette: paletteTh,
  commands: commandsTh,
  prefs: prefsTh,
  apiStatus: apiStatusTh,
  rail: railTh,
  panel: panelTh,
  customer: customerTh,
  toast: toastTh,
  loading: loadingTh,
  errors: errorsTh,
  states: statesTh,
  home: homeTh,
  grade: gradeTh,
  admin: adminTh,
  portal: portalTh,
  newTicket: newTicketTh,
  devHome: devHomeTh,
  notifications: notificationsTh,
  csat: csatTh,
  bulk: bulkTh,
  otherMail: otherMailTh,
  shift: shiftTh,
  outbound: outboundTh,
  ops: opsTh,
  dashboard: dashboardTh,
  reports: reportsTh,
  outboxAdmin: outboxAdminTh,
  investigate: investigateTh,
};
