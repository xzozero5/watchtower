import { describe, expect, it } from 'vitest';

import { destinationFor } from './console-layout';

describe('destinationFor', () => {
  it.each([
    ['/', 'queue'],
    ['/home', 'home'],
    ['/dashboard', 'dashboard'],
    ['/admin/users', 'admin'],
    ['/shift/brief', 'shift'],
    ['/other-mail', 'otherMail'],
    ['/alerts/services', 'alerts'],
    ['/incidents', 'incidents'],
    ['/status-page', 'status-page'],
    ['/tickets/new', 'newTicket'],
  ])('%s is %s', (path, destination) => {
    expect(destinationFor(path)).toBe(destination);
  });
});
