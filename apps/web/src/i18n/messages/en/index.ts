/**
 * English UI copy, one file per namespace (the first key of a message). This is the source of truth
 * for the message shape: `../th/<namespace>.ts` must provide the same keys (the compiler checks
 * it) and every `{placeholder}` must appear in both languages (i18n.test.ts checks it). Never put
 * UI text in a component: add a key to the namespace file here and in `../th`. A new namespace is
 * one new file in each language plus one line in each index.
 */
import type { Widen } from '../types';
import { adminEn } from './admin';
import { attachmentsEn } from './attachments';
import { aiEn } from './ai';
import { aiOfflineEn } from './aiOffline';
import { assistantEn } from './assistant';
import { apiStatusEn } from './apiStatus';
import { appEn } from './app';
import { authEn } from './auth';
import { bulkEn } from './bulk';
import { channelEn } from './channel';
import { commandsEn } from './commands';
import { composerEn } from './composer';
import { emailEn } from './email';
import { conversationEn } from './conversation';
import { csatEn } from './csat';
import { customerEn } from './customer';
import { dashboardEn } from './dashboard';
import { reportsEn } from './reports';
import { procedureEn } from './procedure';
import { detailsEn } from './details';
import { devHomeEn } from './devHome';
import { errorsEn } from './errors';
import { gradeEn } from './grade';
import { homeEn } from './home';
import { investigateEn } from './investigate';
import { keymapEn } from './keymap';
import { liveEn } from './live';
import { loadingEn } from './loading';
import { loginEn } from './login';
import { newTicketEn } from './newTicket';
import { notificationsEn } from './notifications';
import { otherMailEn } from './otherMail';
import { outboxAdminEn } from './outboxAdmin';
import { opsEn } from './ops';
import { outboundEn } from './outbound';
import { paletteEn } from './palette';
import { panelEn } from './panel';
import { panesEn } from './panes';
import { portalEn } from './portal';
import { prefsEn } from './prefs';
import { queueEn } from './queue';
import { railEn } from './rail';
import { rolesEn } from './roles';
import { severityEn } from './severity';
import { shiftEn } from './shift';
import { rosterPlanEn } from './rosterPlan';
import { slaEn } from './sla';
import { statesEn } from './states';
import { stage3En } from './stage3';
import { statusEn } from './status';
import { timelineEn } from './timeline';
import { toastEn } from './toast';
import { topbarEn } from './topbar';
import { workspaceEn } from './workspace';

export const en = {
  app: appEn,
  topbar: topbarEn,
  roles: rolesEn,
  channel: channelEn,
  status: statusEn,
  panes: panesEn,
  queue: queueEn,
  conversation: conversationEn,
  timeline: timelineEn,
  composer: composerEn,
  attachments: attachmentsEn,
  email: emailEn,
  details: detailsEn,
  sla: slaEn,
  workspace: workspaceEn,
  ai: aiEn,
  aiOffline: aiOfflineEn,
  assistant: assistantEn,
  live: liveEn,
  keymap: keymapEn,
  auth: authEn,
  login: loginEn,
  severity: severityEn,
  palette: paletteEn,
  commands: commandsEn,
  prefs: prefsEn,
  apiStatus: apiStatusEn,
  rail: railEn,
  panel: panelEn,
  customer: customerEn,
  toast: toastEn,
  loading: loadingEn,
  errors: errorsEn,
  states: statesEn,
  home: homeEn,
  grade: gradeEn,
  admin: adminEn,
  portal: portalEn,
  newTicket: newTicketEn,
  devHome: devHomeEn,
  notifications: notificationsEn,
  csat: csatEn,
  bulk: bulkEn,
  otherMail: otherMailEn,
  shift: shiftEn,
  rosterPlan: rosterPlanEn,
  outbound: outboundEn,
  ops: opsEn,
  dashboard: dashboardEn,
  reports: reportsEn,
  procedure: procedureEn,
  stage3: stage3En,
  outboxAdmin: outboxAdminEn,
  investigate: investigateEn,
} as const;

/** The shape every language must fill in, with plain `string` leaves. */
export type Messages = Widen<typeof en>;
