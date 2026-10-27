import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.EARSHOT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function lecturerKey() {
  if (process.env.EARSHOT_LECTURER_KEY) return process.env.EARSHOT_LECTURER_KEY;
  const file = path.join(dataDir, 'lecturer-key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir,
  dbFile: process.env.EARSHOT_DB || path.join(dataDir, 'earshot.db'),
  httpPort: Number(process.env.PORT || 8080),
  httpsPort: Number(process.env.HTTPS_PORT || 8443),
  certFile: path.join(dataDir, 'cert.pem'),
  keyFile: path.join(dataDir, 'key.pem'),
  lecturerKey: lecturerKey(),
};
