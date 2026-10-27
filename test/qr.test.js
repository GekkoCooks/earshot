import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../public/js/lib/qr.js';

// Decoding is checked against Chrome's BarcodeDetector by hand; these catch
// structural regressions.
test('QR picks the smallest version that fits', () => {
  assert.equal(qrMatrix('x').length, 21);
  assert.equal(qrMatrix('https://172.168.0.180:8443/c/CS201').length, 29);
  assert.throws(() => qrMatrix('x'.repeat(200)));
});

test('QR has finder patterns in three corners', () => {
  const m = qrMatrix('https://localhost:8443/c/CS201');
  const n = m.length;
  for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(m[y0][x0 + i], true);
      assert.equal(m[y0 + 6][x0 + i], true);
    }
    assert.equal(m[y0 + 1][x0 + 1], false);
    assert.equal(m[y0 + 3][x0 + 3], true);
  }
  assert.match(qrSvg('a'), /^<svg/);
});
