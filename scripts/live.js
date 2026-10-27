// Run Earshot on a public https address for testing across devices.
//   npm run live
//
// Starts the server and opens a Cloudflare quick tunnel (no account needed),
// which gives a trusted https URL that phones and other laptops can open on
// any network. Falls back to localhost.run over ssh if cloudflared is missing.

import { spawn, spawnSync } from 'node:child_process';
import { qrMatrix } from '../public/js/lib/qr.js';

const port = Number(process.env.PORT || 8080);
process.env.PORT = String(port);
// Requests arrive from the tunnel on 127.0.0.1; use the forwarded address for rate limits.
process.env.EARSHOT_TRUST_PROXY = '1';

const { config } = await import('../server/config.js');
await import('../server/index.js');

function terminalQr(text) {
  const m = qrMatrix(text);
  const n = m.length;
  const at = (x, y) => x >= 0 && y >= 0 && x < n && y < n && m[y][x];
  const lines = [];
  for (let y = -2; y < n + 2; y += 2) {
    let line = '  ';
    for (let x = -2; x < n + 2; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function announce(url) {
  process.env.EARSHOT_PUBLIC_URL = url;
  console.log(`
  Public address (works on any network, trusted https)

    Lecturer, on this laptop   http://localhost:${port}/?key=${config.lecturerKey}
    Lecturer, on another device ${url}/?key=${config.lecturerKey}
    Students                   ${url}/c/<COURSE CODE>
    Field test                 ${url}/lab

  Scan to open the field test on a phone:
${terminalQr(url + '/lab')}

  The address changes every time you run this. Press Ctrl+C to stop.
`);
}

function tunnel(cmd, args, pattern) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let found = false;
  const scan = (buf) => {
    const m = pattern.exec(buf.toString());
    if (m && !found) {
      found = true;
      announce(m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', (code) => {
    console.log(`\n  Tunnel closed (${code ?? 'signal'}). Students can no longer reach the server.`);
    process.exit(1);
  });
  const stop = () => {
    child.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const hasCloudflared = spawnSync('cloudflared', ['--version']).status === 0;
if (hasCloudflared) {
  tunnel('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
} else {
  console.log('  cloudflared not found, using localhost.run over ssh instead.');
  tunnel(
    'ssh',
    ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-R', `80:localhost:${port}`, 'nokey@localhost.run'],
    /https:\/\/[a-z0-9-]+\.lhr\.life/,
  );
}
