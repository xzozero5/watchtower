import { SAFE_AUTO_ACK_TEMPLATES } from '../autonomy/safe-templates.js';

/**
 * The text of the automatic acknowledgments, rendered on the server from the template key
 * (ADR-011 follow-up A-3). A caller names a key and never supplies the words: what goes to a
 * customer without a person reading it is fixed here, and holds only facts the customer already has
 * or may have: the ticket key, a link to the portal, and the first-response target (PRD 6.4).
 * `[ASSUMED]` wording and the Thai/English pairing; T-102/T-103 may refine it, in this file, with a
 * reviewer other than the author (N7).
 *
 * Adding a key to `SAFE_AUTO_ACK_TEMPLATES` without a renderer here fails a test, and so does the
 * reverse.
 */

export interface TemplateVars {
  /** `OPS-1234`. */
  readonly ticketKey: string;
  /** Where the customer can follow the request; null leaves the sentence out. */
  readonly portalUrl: string | null;
  /** The first-response target, when the ticket has one. */
  readonly firstResponseDueAt: Date | null;
}

/** `2026-11-02 09:30` in Bangkok time (UTC+7), the instance's business zone `[ASSUMED]`. */
function bangkokTime(date: Date): string {
  const shifted = new Date(date.getTime() + 7 * 3_600_000);
  return `${shifted.toISOString().slice(0, 16).replace('T', ' ')} (UTC+7)`;
}

function received(vars: TemplateVars): string {
  const portalEn = vars.portalUrl === null ? '' : ` You can follow it at ${vars.portalUrl}`;
  const portalTh = vars.portalUrl === null ? '' : ` ติดตามสถานะได้ที่ ${vars.portalUrl}`;
  return [
    `We have received your request and filed it as ${vars.ticketKey}. Our team will review it and reply here.${portalEn}`,
    `เราได้รับเรื่องของคุณแล้ว และบันทึกเป็นหมายเลข ${vars.ticketKey} ทีมงานจะตรวจสอบและตอบกลับที่นี่${portalTh}`,
  ].join('\n\n');
}

function receivedWithSla(vars: TemplateVars): string {
  if (vars.firstResponseDueAt === null) return received(vars);
  const due = bangkokTime(vars.firstResponseDueAt);
  return [received(vars), `We aim to reply by ${due}.`, `เราตั้งเป้าตอบกลับภายใน ${due}`].join(
    '\n\n',
  );
}

const RENDERERS: Readonly<Record<string, (vars: TemplateVars) => string>> = {
  'auto_ack.received': received,
  'auto_ack.received_with_sla': receivedWithSla,
};

/** Keys that can be rendered. */
export const RENDERABLE_TEMPLATE_KEYS: readonly string[] = Object.keys(RENDERERS);

/** The text for a key, or null when the key has no renderer (the caller refuses the send). */
export function renderSystemTemplate(key: string, vars: TemplateVars): string | null {
  const render = Object.hasOwn(RENDERERS, key) ? RENDERERS[key] : undefined;
  return render === undefined ? null : render(vars).trim();
}

/** For the consistency test: the allow-list of the gate and the renderers must name the same keys. */
export function safeKeysWithoutRenderer(): string[] {
  return [...SAFE_AUTO_ACK_TEMPLATES].filter((key) => !Object.hasOwn(RENDERERS, key));
}
