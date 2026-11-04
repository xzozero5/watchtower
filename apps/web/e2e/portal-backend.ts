import { createHash } from 'node:crypto';

import {
  leadingZeroBits,
  powInput,
  type HumanChallenge,
  type PortalMyRequestsView,
  type PortalSubmitted,
  type PortalTicketView,
} from '@watchtower/shared';
import type { Page, Route } from '@playwright/test';

import { makeView } from '../src/test/portal-fixtures';

import { APP_ORIGIN } from './backend';
import { E2E_API_URL } from './constants';

/**
 * A stand-in for the public portal endpoints of apps/api, served from the browser with
 * `page.route` (the full-stack e2e is T-009). Unlike a canned answer it really checks the
 * proof of work (SHA-256 with the same rule as the api), single use of a challenge, the honeypot
 * and the minimum fill time, so these tests fail if the page sends a wrong proof.
 */
export interface PortalRequest {
  method: string;
  path: string;
  at: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface PortalOptions {
  difficultyBits?: number;
  minFillSeconds?: number;
  /** The tracking value the api accepts. Any other value gets 401. */
  validToken?: string;
  view?: PortalTicketView;
  /** Answers `POST /v1/portal/tickets` instead of the built-in checks. */
  submit?: () => { status: number; json: unknown; headers?: Record<string, string> };
  /** Answers `POST /v1/portal/tickets/:key/replies`. */
  reply?: () => { status: number; json: unknown };
  /** The one-time "my requests" link value the api accepts (once). Default `LIST_VALUE`. */
  listToken?: string;
  /** What `POST /v1/portal/my-requests/open` returns. Default `MY_REQUESTS`. */
  myRequests?: PortalMyRequestsView;
  /** Answers `POST /v1/portal/track/resend`. */
  resend?: () => { status: number; json: unknown; headers?: Record<string, string> };
}

export const SUBMITTED: PortalSubmitted = {
  ticketKey: 'OPS-12',
  maskedEmail: 'a***@example.com',
  status: 'received',
  expectedFirstResponseAt: '2026-11-05T08:00:00.000Z',
};

export const SAMPLE_VALUE = 'c2FtcGxlLXZhbHVlLWZvci1lMmU';
/** The one-time "my requests" link value the stand-in accepts, once (T-152). Not a credential. */
export const LIST_VALUE = 'wtl1.c2FtcGxlLWxpc3QtdmFsdWUtZm9yLWUyZS0wMTIzNDU2Nzg';

export const MY_REQUESTS: PortalMyRequestsView = {
  maskedEmail: 'a***@example.com',
  truncated: false,
  items: [
    {
      key: 'OPS-12',
      subject: 'Cannot log in',
      status: 'in_progress',
      statusLabel: 'In progress',
      createdAt: '2026-11-05T03:00:00.000Z',
      updatedAt: '2026-11-05T04:30:00.000Z',
      trackingToken: SAMPLE_VALUE,
    },
    {
      key: 'OPS-7',
      subject: 'Old invoice question',
      status: 'closed',
      statusLabel: 'Closed',
      createdAt: '2026-10-01T03:00:00.000Z',
      updatedAt: '2026-10-02T04:30:00.000Z',
      trackingToken: null,
    },
  ],
};

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-headers': 'content-type, x-portal-token',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'retry-after',
};

export const errorBody = (statusCode: number, code: string) => ({
  statusCode,
  error: 'Error',
  code,
  message: code,
});

export async function mockPortal(page: Page, options: PortalOptions = {}) {
  const bits = options.difficultyBits ?? 10;
  const minFill = options.minFillSeconds ?? 0;
  const validToken = options.validToken ?? SAMPLE_VALUE;
  const requests: PortalRequest[] = [];
  const issued = new Map<string, number>();
  const used = new Set<string>();
  let counter = 0;
  let view = options.view ?? makeView();
  let listSpent = false;

  const fulfill = (
    route: Route,
    status: number,
    json?: unknown,
    headers: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      headers: { ...CORS, 'content-type': 'application/json', ...headers },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });

  await page.route(`${E2E_API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = request.postData() ? (request.postDataJSON() as unknown) : undefined;
    requests.push({ method, path: url.pathname, at: Date.now(), body, headers: request.headers() });
    const key = `${method} ${url.pathname}`;

    if (key === 'GET /v1/portal/challenge') {
      counter += 1;
      const challenge: HumanChallenge = {
        provider: 'pow-sha256',
        challenge: `e2e-challenge-${String(counter)}`,
        difficultyBits: bits,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        minFillSeconds: minFill,
      };
      issued.set(challenge.challenge, Date.now());
      return fulfill(route, 200, challenge);
    }

    if (key === 'POST /v1/portal/tickets') {
      if (options.submit) {
        const result = options.submit();
        return fulfill(route, result.status, result.json, result.headers);
      }
      const form = body as {
        website?: string;
        verification?: { challenge: string; nonce: string };
      };
      const proof = form.verification;
      const issuedAt = proof ? issued.get(proof.challenge) : undefined;
      const digest = proof
        ? createHash('sha256').update(powInput(proof.challenge, proof.nonce), 'utf8').digest()
        : null;
      const valid =
        proof !== undefined &&
        issuedAt !== undefined &&
        !used.has(proof.challenge) &&
        digest !== null &&
        leadingZeroBits(digest) >= bits &&
        (form.website ?? '') === '' &&
        Date.now() - issuedAt >= minFill * 1000;
      if (!valid) return fulfill(route, 400, errorBody(400, 'verification_failed'));
      used.add(proof.challenge);
      return fulfill(route, 201, SUBMITTED);
    }

    // "My requests" (T-152): the proof is checked like a submit's; the one-time link works once.
    if (key === 'POST /v1/portal/my-requests') {
      const form = body as {
        website?: string;
        verification?: { challenge: string; nonce: string };
      };
      if ((form.website ?? '') !== '') return fulfill(route, 202, { status: 'accepted' });
      const proof = form.verification;
      const digest = proof
        ? createHash('sha256').update(powInput(proof.challenge, proof.nonce), 'utf8').digest()
        : null;
      const valid =
        proof !== undefined &&
        issued.has(proof.challenge) &&
        !used.has(proof.challenge) &&
        digest !== null &&
        leadingZeroBits(digest) >= bits;
      if (!valid) return fulfill(route, 400, errorBody(400, 'verification_failed'));
      used.add(proof.challenge);
      return fulfill(route, 202, { status: 'accepted' });
    }
    if (key === 'POST /v1/portal/my-requests/open') {
      const presented = request.headers()['x-portal-token'];
      if (presented !== (options.listToken ?? LIST_VALUE) || listSpent) {
        return fulfill(route, 401, errorBody(401, 'invalid_or_expired_link'));
      }
      listSpent = true;
      return fulfill(route, 200, options.myRequests ?? MY_REQUESTS);
    }

    const ticket = /^\/v1\/portal\/tickets\/([^/]+)(\/replies)?$/.exec(url.pathname);
    if (ticket && request.headers()['x-portal-token'] !== validToken) {
      return fulfill(route, 401, errorBody(401, 'invalid_or_expired_link'));
    }
    if (ticket && method === 'GET' && !ticket[2]) return fulfill(route, 200, view);
    if (ticket && method === 'POST' && ticket[2]) {
      if (options.reply) {
        const result = options.reply();
        return fulfill(route, result.status, result.json);
      }
      const text = (body as { body: string }).body;
      const message = {
        id: 'b0000000-0000-4000-8000-000000000001',
        from: 'customer' as const,
        authorName: null,
        body: text,
        createdAt: new Date().toISOString(),
      };
      view = {
        ...view,
        timeline: [...view.timeline, { kind: 'message', ...message }],
        updatedAt: message.createdAt,
      };
      return fulfill(route, 201, { message, status: view.status, statusLabel: view.statusLabel });
    }

    if (key === 'POST /v1/portal/track/resend') {
      if (options.resend) {
        const result = options.resend();
        return fulfill(route, result.status, result.json, result.headers);
      }
      return fulfill(route, 202, { status: 'accepted' });
    }
    return fulfill(route, 404, errorBody(404, 'not_found'));
  });

  return {
    requests,
    to: (method: string, path: string) =>
      requests.filter((request) => request.method === method && request.path === path),
  };
}
