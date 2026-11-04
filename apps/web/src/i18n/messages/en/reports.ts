/**
 * The AI cost dashboard (T-305a) and the CEO view (T-305b). Short on purpose: definitions sit behind `?` buttons.
 * A figure that is missing says why (the `dashboard.na.*` words); the savings formula is printed on the page
 * because it is an assumption (N5).
 */
export const reportsEn = {
  links: {
    cost: 'AI cost',
    ceo: 'CEO view',
    ops: 'Ops dashboard',
    budget: 'Today against the daily caps',
  },
  refresh: 'Refresh',
  updated: 'Updated',
  trend: {
    up: '+{amount} vs previous period',
    down: '−{amount} vs previous period',
    flat: 'Same as previous period',
    points: '{amount} pts',
    noBase: 'No previous period to compare',
  },
  cost: {
    title: 'AI cost',
    loading: 'Loading AI cost…',
    loadError: 'Could not load AI cost.',
    retry: 'Try again',
    budgetLead: 'What the AI spent over time. Today against the caps is on the AI controls page.',
    budgetLink: 'Today against the daily caps',
    tiles: {
      cost: 'Cost',
      tokens: 'Tokens',
      runs: 'Model calls',
      tickets: 'Tickets with AI',
      costInfo:
        'Money for calls that have a price. Calls without a price are counted apart, not as zero.',
      costInfoLabel: 'About cost',
      unpriced: '{count} calls without a price',
      allPriced: 'All calls priced',
      tokensDetail: '{input} in, {output} out',
      ticketsDetail: 'Calls not tied to a ticket are not counted here',
    },
    byDay: {
      title: 'Cost per day',
      value: 'Cost',
      category: 'Day',
      empty: 'No days in this window',
      keys: 'Use the arrow keys to read each day',
    },
    byAgent: {
      title: 'Cost per agent',
      lead: 'Which part of the product spends',
      value: 'Cost',
      category: 'Agent',
      empty: 'No AI calls in this window',
    },
    byIntent: {
      title: 'Cost per intent',
      value: 'Cost',
      category: 'Intent',
      none: 'No intent',
      others: 'Other intents',
      empty: 'No AI calls in this window',
    },
    topTickets: {
      title: 'Tickets that cost the most',
      empty: 'No ticket used AI in this window',
      ticket: 'Ticket',
      calls: 'Calls',
      tokens: 'Tokens',
      cost: 'Cost',
      open: 'Open {key}',
    },
    chart: { showTable: 'Show as table', showChart: 'Show as chart' },
    agents: {
      classifier: 'Intent classifier',
      summarizer: 'Summarizer',
      drafter: 'Reply drafter',
      investigator: 'Investigator',
      grader: 'Grader',
      assistant: 'Assistant',
    },
  },
  ceo: {
    title: 'CEO view',
    loading: 'Loading the CEO view…',
    loadError: 'Could not load the CEO view.',
    retry: 'Try again',
    lead: 'One page for the week: each figure next to the period before it.',
    seedExcluded: 'Demo (seed) tickets are not counted.',
    export: {
      label: 'Export',
      csv: 'CSV',
      html: 'HTML',
      failed: 'Could not export. Try again.',
    },
    kpi: {
      volume: 'Ticket volume',
      firstResponse: 'First response (median)',
      resolution: 'Resolution time (median)',
      sla: 'SLA compliance',
      csat: 'CSAT',
      aiHandled: 'AI-assisted',
      verifiedResolution: 'Verified resolutions',
      automationSavings: 'Automation savings',
    },
    info: {
      label: 'About {name}',
      volume: 'Tickets created in the window.',
      firstResponse:
        'Wall-clock time from creation to the first reply, median of tickets created in the window.',
      resolution:
        'Wall-clock time from creation to resolution, median of tickets created in the window.',
      sla: 'Tickets whose first reply and resolution deadlines were met, of those whose deadline has passed or was reached.',
      csat: 'Average score of answered surveys sent in the window.',
      aiHandled:
        'Share of resolved tickets where a person sent an AI draft, unchanged or edited. This is help, not the AI answering alone.',
      verifiedResolution:
        'Share of graded resolutions the AI grader could verify from evidence. Mock grades are not counted.',
      automationSavings:
        'Hours a person would have spent on the AI-assisted tickets. An assumption, see the formula below.',
    },
    detail: {
      samples: 'on {count} tickets',
      surveys: 'from {count} surveys',
      graded: 'of {count} graded',
      assisted: '{count} tickets, {noTouch} unchanged',
    },
    unit: { hours: '{value} h' },
    formula: {
      title: 'How automation savings are worked out',
      assumed: 'This is an assumption, not a measurement.',
      line: 'Hours = AI-assisted resolved tickets ({tickets}) × {minutes} minutes ÷ 60 = {hours} h.',
      cost: 'Saved cost = hours × {rate} per hour = {saved}.',
      noCost:
        'No hourly cost is set, so no money figure is shown. The owner sets it in the server settings.',
      aiCost: 'AI spend in the window: {spent}. Net: {net}.',
      perTicket: 'AI cost per resolved ticket: {current} (previous period: {previous}).',
      none: 'none',
      unknown: 'not available',
      settings: 'The minutes and the hourly cost are server settings, not code.',
    },
    external: {
      title: 'Other figures',
      lead: 'Numbers the system does not compute, fed by the API or a CSV import.',
      empty: 'No other figures yet.',
      observed: 'as of {date}',
      remove: 'Remove {name}',
      removeTitle: 'Remove “{name}”?',
      removeBody: 'The tile and all its recorded values are deleted.',
      removeConfirm: 'Remove',
      manage: {
        title: 'Add or update figures',
        csvLabel: 'CSV',
        csvHint:
          'Columns: key, label, unit, higher_is_better, value, observed_at (one row per value).',
        fileLabel: 'Choose a CSV file',
        import: 'Import',
        importing: 'Importing…',
        done: 'Imported {count} values.',
        failed: 'Could not import: {message}',
      },
    },
  },
} as const;
