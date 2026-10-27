import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb(config.dbFile);
const app = createApp({ db, lecturerKey: config.lecturerKey, publicDir: config.publicDir });

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

http.createServer(app.handle).listen(config.httpPort, () => {
  const hasCert = fs.existsSync(config.certFile) && fs.existsSync(config.keyFile);
  const lan = lanAddresses();
  const lines = ['', '  Earshot is running', ''];
  lines.push(`  Lecturer (this laptop)  http://localhost:${config.httpPort}/?key=${config.lecturerKey}`);

  if (hasCert) {
    https
      .createServer({ cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) }, app.handle)
      .listen(config.httpsPort);
    for (const ip of lan) lines.push(`  Students (same Wi-Fi)   https://${ip}:${config.httpsPort}/c/<COURSE>`);
  } else {
    lines.push('', '  Phones need HTTPS to use the microphone. Run `npm run cert` once, then restart.');
  }
  lines.push('');
  console.log(lines.join('\n'));
});
