import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const directory = mkdtempSync(join(tmpdir(), 'linki-test-'));
process.env.LINKI_DB_PATH = join(directory, 'test.db');
process.env.LINKI_DISABLE_BACKGROUND = '1';
process.env.NEXTAUTH_SECRET = 'synthetic-test-secret-never-use-in-production';
process.env.NEXT_TELEMETRY_DISABLED = '1';
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

// Tests may use local SMTP/IMAP/HTTP fixtures, never external sockets.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  if (typeof options === 'object' && options !== null && options.path) {
    return connect.apply(this, args);
  }
  const host = typeof options === 'object' && options !== null
    ? options.host ?? 'localhost'
    : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`External network blocked in tests: ${host}`);
  }
  return connect.apply(this, args);
};
