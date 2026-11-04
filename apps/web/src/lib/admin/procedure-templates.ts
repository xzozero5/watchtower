import type { ProcedureSteps } from '@watchtower/shared';

/**
 * Starter procedures for the editor (T-303e). A copy of `examples/procedures/*.json`: the web bundle cannot read
 * files outside the app, and `procedure-templates.test.ts` keeps the two equal. Generic, no organization named (N1).
 */
export interface ProcedureTemplate {
  key: string;
  name: string;
  description: string;
  sourceMd: string;
  steps: ProcedureSteps;
}

export const PROCEDURE_TEMPLATES: readonly ProcedureTemplate[] = [
  {
    key: 'investigate_then_reply',
    name: 'Investigate, then reply with care',
    description:
      'Look at the knowledge base, similar tickets and the organization first. Reply only with what the evidence supports.',
    sourceMd:
      '1. Search the knowledge base for the problem.\n2. Look at similar tickets that were resolved, and at the organization.\n3. Check that the evidence shows a likely cause. If it does not, say so in the report.\n4. Write the reply plainly and name what we know and what we do not know yet.\n5. Never promise a time to fix.',
    steps: {
      schemaVersion: 1,
      autosend: 'never',
      steps: [
        {
          kind: 'tool',
          id: 'search_kb',
          tool: 'kb_search',
          params: {
            limit: 5,
          },
        },
        {
          kind: 'tool',
          id: 'find_similar',
          tool: 'similar_tickets',
          params: {
            limit: 5,
          },
        },
        {
          kind: 'tool',
          id: 'look_up_org',
          tool: 'org_context',
        },
        {
          kind: 'check',
          id: 'cause_supported',
          question:
            'Does the evidence from the knowledge base and the similar tickets point to a likely cause?',
          evidenceFrom: ['search_kb', 'find_similar'],
        },
        {
          kind: 'reply_guideline',
          id: 'plain_reply',
          text: 'Say what we know and what we do not know yet. Do not promise a time to fix.',
        },
      ],
    },
  },
  {
    key: 'escalate_urgent_to_lead',
    name: 'Urgent or unsure: a person looks first',
    description:
      'A P1 ticket goes to a lead. A draft the system is unsure about is never sent without a person.',
    sourceMd:
      '1. Search the knowledge base and look at similar tickets.\n2. If the ticket is P1, hand it to a lead with a short note.\n3. If the classifier is less than 60% sure, a person must read the draft before anything goes out.',
    steps: {
      schemaVersion: 1,
      autosend: 'never',
      steps: [
        {
          kind: 'tool',
          id: 'search_kb',
          tool: 'kb_search',
          params: {
            limit: 5,
          },
        },
        {
          kind: 'tool',
          id: 'find_similar',
          tool: 'similar_tickets',
          params: {
            limit: 5,
          },
        },
        {
          kind: 'escalate',
          id: 'p1_to_lead',
          when: {
            all: [
              {
                field: 'ticket.priority',
                op: 'eq',
                value: 'P1',
              },
            ],
          },
          to: {
            role: 'lead',
          },
          note: 'P1 ticket: a lead should look at it first.',
        },
        {
          kind: 'require_human',
          id: 'unsure_classifier',
          when: {
            all: [
              {
                field: 'classifier.confidence',
                op: 'lte',
                value: 0.6,
              },
            ],
          },
          reason: 'The classifier is not sure about the intent.',
        },
      ],
    },
  },
  {
    key: 'disclosure_guard',
    name: 'Protect what must not be shared',
    description:
      'Keep internal causes out of replies, and share account details only with a verified contact.',
    sourceMd:
      '1. Search the knowledge base and look up the organization.\n2. Never mention internal system names or the cause of an incident in a reply.\n3. Share details of the account only when the contact is verified.\n4. Keep the reply short and polite.',
    steps: {
      schemaVersion: 1,
      autosend: 'never',
      steps: [
        {
          kind: 'tool',
          id: 'search_kb',
          tool: 'kb_search',
          params: {
            limit: 5,
          },
        },
        {
          kind: 'tool',
          id: 'look_up_org',
          tool: 'org_context',
        },
        {
          kind: 'disclosure',
          id: 'no_internal_names',
          rule: 'never_mention',
          topic: 'Internal system names and the technical cause of an incident',
        },
        {
          kind: 'disclosure',
          id: 'account_details_verified',
          rule: 'verified_only',
          topic: 'Details of the customer account',
        },
        {
          kind: 'reply_guideline',
          id: 'short_polite',
          text: 'Keep the reply short and polite.',
        },
      ],
    },
  },
];
