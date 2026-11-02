// Preloaded (NODE_OPTIONS=--require) into the api, worker and web processes of the e2e stack (T-113).
// A mock stack must not reach anything but this machine: every outbound TCP connection to an address
// that is not loopback is refused and appended to E2E_NET_LOG as one JSON line (host and port only),
// and the test run fails when that file is not empty. Unix sockets and loopback pass.
'use strict';
const net = require('node:net');
const { appendFileSync } = require('node:fs');

const logFile = process.env.E2E_NET_LOG;
const LOOPBACK = /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3}|::ffff:127(\.\d{1,3}){3})$/i;

function target(args) {
  const first = args[0];
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return null;
    return { host: first.host ?? 'localhost', port: first.port };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return null; // a pipe path
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const where = target(args);
  if (where !== null && !LOOPBACK.test(String(where.host))) {
    if (logFile) {
      try {
        appendFileSync(
          logFile,
          `${JSON.stringify({ pid: process.pid, host: String(where.host), port: where.port })}\n`,
        );
      } catch {
        // The guard still refuses.
      }
    }
    const error = new Error(`e2e: outbound connection to ${String(where.host)} refused`);
    error.code = 'E2E_NO_NETWORK';
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};
