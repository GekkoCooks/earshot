// Arithmetic in GF(16), the field Reed-Solomon works over.
// Primitive polynomial x^4 + x + 1, generator alpha = 2.

const PRIM = 0b10011;

export const EXP = new Uint8Array(30);
export const LOG = new Uint8Array(16);

{
  let x = 1;
  for (let i = 0; i < 15; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x10) x ^= PRIM;
  }
  for (let i = 15; i < 30; i++) EXP[i] = EXP[i - 15];
}

export const add = (a, b) => a ^ b;

export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function div(a, b) {
  if (b === 0) throw new Error('GF16 divide by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 15 - LOG[b]) % 15];
}

export function pow(a, n) {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return EXP[(LOG[a] * n) % 15];
}
