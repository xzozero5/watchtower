import { createRedactor } from '@watchtower/ai';
import { describe, expect, it } from 'vitest';

import { conversationGetFacts } from './tools/conversation.tools.js';
import { ticketTimelineFacts } from './tools/ticket-timeline.tool.js';

describe('C-2 Regression: No premature cut before factBlock redaction', () => {
  const customerName = 'สมชาย ใจดี';
  const customerEmail = 'somchai.jaidee@example.com';
  const redactor = createRedactor({
    names: () => [customerName],
  });

  it('preserves full names in ticket_timeline past character 240 without splitting', () => {
    // Generate text where customer name straddles around character 230-250
    const padding = 'A'.repeat(235);
    const bodyText = `${padding} ${customerName} was here with ${customerEmail}.`;

    const facts = ticketTimelineFacts({
      ticketId: '11111111-1111-4111-8111-111111111111',
      nextCursor: null,
      entries: [
        {
          kind: 'message',
          id: '22222222-2222-4222-8222-222222222222',
          ticketKey: 'OPS-101',
          from: 'customer',
          senderName: 'Customer Sender',
          text: bodyText,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(facts).toHaveLength(1);
    const factText = facts[0]?.text ?? '';
    expect(factText).toContain(customerName);

    // Apply redaction session
    const session = redactor.session({ scope: 'conv-1' });
    const redacted = session.redactToolOutput('ticket_timeline', factText);
    expect(redacted).not.toContain(customerName);
    expect(redacted).not.toContain(customerEmail);
    expect(redacted).toContain('[NAME_1]');
    expect(redacted).toContain('[EMAIL_1]');
  });

  it('preserves full names in conversation_get without premature cutAtWord', () => {
    // Generate text where customer name straddles around character 290-310
    const padding = 'Message content '.repeat(20); // ~320 chars
    const bodyText = `${padding} Contact: ${customerName} at ${customerEmail}`;

    const facts = conversationGetFacts({
      conversation: {
        id: '33333333-3333-4333-8333-333333333333',
        channel: 'email',
        disposition: 'internal',
        fromName: customerName,
        fromAddress: customerEmail,
        subject: `Important subject straddling ${customerName}`,
        snippet: `Snippet straddling ${customerName}`,
        receivedAt: new Date().toISOString(),
        bodyText,
      },
    });

    expect(facts).toHaveLength(1);
    const factText = facts[0]?.text ?? '';
    expect(factText).toContain(customerName);

    const session = redactor.session({ scope: 'conv-2' });
    const redacted = session.redactToolOutput('conversation_get', factText);
    expect(redacted).not.toContain(customerName);
    expect(redacted).not.toContain(customerEmail);
  });
});
