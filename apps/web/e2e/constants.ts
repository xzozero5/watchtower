// A port nothing listens on. The e2e server is started with this API_URL and the tests intercept it
// in the browser, which proves the URL is read at runtime and not baked in at build time.
export const E2E_API_URL = 'http://127.0.0.1:4999';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
