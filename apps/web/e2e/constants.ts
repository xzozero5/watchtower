export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);

// A port nothing listens on. The e2e server is started with this API_URL and the tests intercept it
// in the browser, which proves the URL is read at runtime and not baked in at build time.
// E2E_API_PORT moves it so two suites can run side by side (like E2E_PORT for the web server).
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4999);
export const E2E_API_URL = `http://127.0.0.1:${String(E2E_API_PORT)}`;
export const E2E_API_WS_URL = `ws://127.0.0.1:${String(E2E_API_PORT)}`;
