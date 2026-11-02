export const loginEn = {
  title: 'Sign in',
  loading: 'Loading sign-in options',
  email: 'Email address',
  password: 'Password',
  signingIn: 'Signing in',
  configError: {
    title: 'Sign-in is not available right now',
    body: 'The API could not be reached. Try again in a moment.',
  },
  errors: {
    failed: 'Could not sign in',
    generic: 'Something went wrong. Try again.',
    network: 'The API could not be reached. Try again.',
    rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  },
  staff: {
    title: 'Team members',
  },
  sso: {
    button: 'Continue with {provider}',
    notConfigured: '{provider} sign-in is not set up on this instance.',
    errors: {
      title: 'Sign-in did not complete',
      stateInvalid: 'The sign-in session expired or did not start here. Start again.',
      denied: 'The sign-in was cancelled or refused.',
      unavailable: 'The sign-in service could not be reached. Try again soon.',
      emailNotVerified: 'Your email address is not verified with the provider.',
      domainNotAllowed: 'This account is not from an organization allowed here.',
      notProvisioned: 'Your account has not been set up yet. Ask an administrator.',
      accountDisabled: 'This account is disabled. Ask an administrator.',
      accountMismatch: 'This sign-in does not match the account on file. Ask an administrator.',
      unknown: 'Sign-in failed. Try again, or ask an administrator.',
    },
  },
  dev: {
    title: 'Development sign-in',
    badge: 'Dev',
    description: 'Only available on a development instance without single sign-on.',
    role: 'Role',
    button: 'Sign in for development',
  },
  client: {
    title: 'Customers',
    trackingHint:
      'Following a request? Use the tracking link in your confirmation email. You do not need an account.',
    button: 'Email me a sign-in link',
    sending: 'Sending',
    sentTitle: 'Check your email',
    sentBody:
      'If that address belongs to a customer account, a sign-in link is on its way. It works once and expires soon.',
  },
  breakGlass: {
    title: 'Emergency administrator sign-in',
    description:
      'For administrators when single sign-on is unavailable. Every attempt is recorded.',
    button: 'Sign in',
    invalid: 'Wrong email or password, or the account is temporarily locked.',
  },
  magic: {
    title: 'Signing you in',
    verifying: 'Checking your sign-in link',
    failedTitle: 'This sign-in link cannot be used',
    failedBody: 'It has expired, was already used, or is incomplete. Ask for a new link.',
    requestNew: 'Back to sign-in',
  },
  brand: {
    tagline: 'Tech operations, in one place.',
  },
} as const;
