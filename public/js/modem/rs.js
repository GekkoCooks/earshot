// Reed-Solomon RS(12, 8) over GF(16).
//
// 8 data nibbles + 4 parity nibbles. Four parity symbols could correct two
// errors, but correcting two would accept about 23% of random noise as a
// "valid" codeword. We correct at most one error (miscorrection chance
// about 0.3%) and rely on repeated frames to fix the rest.
//
// Codewords are arrays in transmission order. Index i holds the coefficient
// of x^(N - 1 - i), so data comes first and parity last.

import { EXP, LOG, mul, div } from './gf16.js';

export const K = 8;
export const PARITY = 4;
export const N = K + PARITY;

// g(x) = (x - a^0)(x - a^1)(x - a^2)(x - a^3), coefficients high to low.
const GEN = (() => {
  let g = [1];
  for (let j = 0; j < PARITY; j++) {
    const root = EXP[j];
    const next = new Array(g.length + 1).fill(0);
    for (let i = 0; i < g.length; i++) {
      next[i] ^= g[i];
      next[i + 1] ^= mul(g[i], root);
    }
    g = next;
  }
  return g;
})();

export function encode(data) {
  if (data.length !== K) throw new Error(`RS encode expects ${K} nibbles`);
  const rem = [...data, 0, 0, 0, 0];
  for (let i = 0; i < K; i++) {
    const coef = rem[i];
    if (coef === 0) continue;
    for (let j = 1; j <= PARITY; j++) rem[i + j] ^= mul(GEN[j], coef);
  }
  return [...data, ...rem.slice(K)];
}

export function syndromes(word) {
  const s = [];
  for (let j = 0; j < PARITY; j++) {
    let acc = 0;
    for (let i = 0; i < N; i++) {
      if (word[i] === 0) continue;
      const pos = N - 1 - i;
      acc ^= EXP[(LOG[word[i]] + j * pos) % 15];
    }
    s.push(acc);
  }
  return s;
}

/**
 * Decode a received word. Returns { data, corrected } or null when the word
 * has more than one error (or is noise).
 */
export function decode(word) {
  if (word.length !== N) return null;
  const s = syndromes(word);
  if (s.every((v) => v === 0)) return { data: word.slice(0, K), corrected: 0 };

  // A single error of magnitude e at position p gives S_j = e * X^j, X = a^p.
  if (s[0] === 0 || s[1] === 0) return null;
  const x = div(s[1], s[0]);
  if (mul(s[1], x) !== s[2] || mul(s[2], x) !== s[3]) return null;
  const pos = LOG[x];
  if (pos >= N) return null;
  const fixed = word.slice();
  fixed[N - 1 - pos] ^= s[0];
  return { data: fixed.slice(0, K), corrected: 1 };
}
