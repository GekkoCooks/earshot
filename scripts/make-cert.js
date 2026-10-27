// Make a self-signed certificate so phones on the same Wi-Fi can use the
// microphone (browsers only allow it over https). Needs openssl.
//   npm run cert

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { config } from '../server/config.js';

const ips = ['127.0.0.1'];
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
}
const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '397', '-subj', '/CN=Earshot local', '-addext', `subjectAltName=${san}`,
    '-keyout', config.keyFile, '-out', config.certFile,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('openssl failed. Install it, or use a tunnel (see README).\n' + (e.stderr?.toString() || e.message));
  process.exit(1);
}
fs.chmodSync(config.keyFile, 0o600);
console.log(`Certificate for ${san.replace(/DNS:|IP:/g, '')}`);
console.log(`Saved to ${config.certFile}. Restart the server.`);
console.log('Phones will warn that the certificate is not trusted. Tap through once (Advanced, then Proceed).');
