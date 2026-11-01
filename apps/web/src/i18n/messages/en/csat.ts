/**
 * English copy of the public CSAT survey page (T-110b, PRD R-10.2). Its own file, merged into the
 * main catalogue as `csat`, like the portal. Same rules as en/index.ts: add every key to ../th/csat.ts too.
 */
export const csatEn = {
  title: 'How did we do?',
  intro: 'Your request {key} was resolved. Tell us how it went. It takes a few seconds.',
  loading: 'Opening your survey…',
  score: {
    legend: 'How satisfied are you with the support you received?',
    s1: 'Very unhappy',
    s2: 'Unhappy',
    s3: 'Okay',
    s4: 'Happy',
    s5: 'Very happy',
    option: '{score} out of 5: {label}',
  },
  resolved: {
    legend: 'Was your problem resolved?',
    yes: 'Yes, it is resolved',
    no: 'No, I still need help',
    hint: 'If not, we will reopen your request.',
  },
  comment: {
    label: 'Anything you would like to add?',
    optional: 'optional',
    count: '{count} of {max}',
  },
  submit: 'Send my answer',
  sending: 'Sending…',
  errors: {
    scoreRequired: 'Please choose a rating from 1 to 5.',
    commentTooLong: 'Your comment is too long. Please shorten it.',
    network: "We couldn't reach the server. Check your connection and try again.",
    rateLimited: 'Too many attempts. Please try again in {time}.',
    server: 'Something went wrong on our side. Please try again in a moment.',
  },
  done: {
    title: 'Thank you',
    body: 'Your answer was recorded. It helps us improve.',
  },
  answered: {
    title: 'Already answered',
    body: 'This survey has already been answered. Thank you.',
  },
  invalid: {
    title: 'This link does not work',
    body: 'The link may have expired or is not valid. If you still want to share feedback, reply to the email from our team.',
  },
} as const;
