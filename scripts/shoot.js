// Screenshot pages for review and for the README.
//   node scripts/shoot.js <outDir> <name>=<path>[@WxH][:dark] ...
// The server must already be running on BASE (default http://localhost:8080).

import { launch, openPage } from './lib/cdp.js';

const base = process.env.BASE || 'http://localhost:8080';
const [outDir, ...shots] = process.argv.slice(2);
const chrome = await launch();
try {
  const page = await openPage(chrome.port);
  if (process.env.KEY) {
    await page.goto(`${base}/?key=${process.env.KEY}`, 600);
  }
  for (const spec of shots) {
    const m = /^([\w-]+)=([^@:]+)(?:@(\d+)x(\d+))?(:dark)?(:full)?$/.exec(spec);
    if (!m) throw new Error(`bad spec ${spec}`);
    const [, name, p, w = 390, h = 844, dark, full] = m;
    await page.viewport(Number(w), Number(h), { dark: !!dark, mobile: Number(w) < 700 });
    await page.goto(base + p, Number(process.env.SETTLE || 700));
    if (process.env.EVAL) {
      await page.eval(process.env.EVAL);
      await new Promise((r) => setTimeout(r, 1500));
    }
    await page.screenshot(`${outDir}/${name}.png`, { fullPage: !!full });
    console.log('saved', name);
  }
  page.close();
} finally {
  await chrome.close();
}
