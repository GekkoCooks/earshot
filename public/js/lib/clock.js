// Estimate the server clock from a few round trips; keep the one with the
// shortest round trip, since it has the least uncertainty.

let offset = 0;

export async function syncClock(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch('/api/time', { cache: 'no-store' });
      const { now } = await res.json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: now - (t0 + rtt / 2) };
    } catch {
      /* try the next one */
    }
  }
  if (best) offset = best.offset;
  return best;
}

export const serverNow = () => Date.now() + offset;
