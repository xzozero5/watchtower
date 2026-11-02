import type { TicketAiInsight } from '@watchtower/shared';

import type { MaskingSession } from '../masking/pii-masker.js';

/**
 * The AI brief as a masked reader (`dev`, T-137) gets it. Everything the model or a tool wrote goes
 * through the redactor again, because the brief is stored with the customer's own words restored for staff:
 * the summary, the reason for the intent, the next step, every evidence card (a log line or a data row can
 * hold anything) and the report. Enums, numbers, ids and times pass unchanged.
 *
 * Left out altogether: the draft reply. It is text addressed to the customer, a developer cannot send or
 * approve it (N3), and it is the part of the brief most likely to repeat what the customer said. An
 * external link on an evidence card is dropped too (a query string can carry an identifier); a path
 * inside Watchtower stays.
 */
export function maskInsight(insight: TicketAiInsight, session: MaskingSession): TicketAiInsight {
  const rest = { ...insight };
  delete rest.draft;
  return {
    ...rest,
    ...(insight.summary === undefined ? {} : { summary: session.text(insight.summary) }),
    ...(insight.intent === undefined
      ? {}
      : { intent: { ...insight.intent, reason: session.text(insight.intent.reason) } }),
    ...(insight.nextStep === undefined
      ? {}
      : { nextStep: { ...insight.nextStep, label: session.text(insight.nextStep.label) } }),
    evidence: insight.evidence.map(({ href, ...card }) => ({
      ...card,
      title: session.text(card.title),
      snippet: session.text(card.snippet),
      ...(href !== undefined && href.startsWith('/') && !href.startsWith('//') ? { href } : {}),
    })),
    ...(insight.report === undefined
      ? {}
      : {
          report: {
            ...insight.report,
            findings: insight.report.findings.map((finding) => ({
              ...finding,
              text: session.text(finding.text),
            })),
            likelyCause: session.textOrNull(insight.report.likelyCause),
            openQuestions: insight.report.openQuestions.map((question) => session.text(question)),
          },
        }),
  };
}
