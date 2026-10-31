export interface RuntimeConfig {
  /** Base URL of apps/api as the browser reaches it, with no trailing slash. */
  apiUrl: string;
}

/** Matches `API_URL` in .env.example. `[ASSUMED]` for a bare local run. */
export const DEFAULT_API_URL = 'http://localhost:4000';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads configuration from the environment when a request arrives, never at build time, so one
 * image runs unchanged in compose and on Cloud Run (ADR-001). Do not use NEXT_PUBLIC_* for these
 * values: Next.js bakes those into the bundle during `next build`.
 *
 * Call it from a server component or route, and pass the result to client components as props or
 * through context. It throws on a malformed URL so a bad deploy fails loudly, not as a blank page
 * of failed requests.
 */
export function readRuntimeConfig(env: Env = process.env): RuntimeConfig {
  const raw = env.API_URL?.trim();
  const apiUrl = raw ? raw : DEFAULT_API_URL;

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('API_URL must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('API_URL must use http or https');
  }
  return { apiUrl: apiUrl.replace(/\/+$/, '') };
}
