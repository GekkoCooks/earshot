// The listening picture: a scrolling spectrogram of the tones the phone hears,
// and the 12 code slots that fill in as symbols are caught. Each caught slot
// shows its mark at the pitch it was heard at.

export class Waterfall {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colPx = 3;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width) return;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    this.dpr = dpr;
    // Setting the size clears the canvas, so only do it when it changed.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.color = getComputedStyle(this.canvas).color;
  }

  push(spectrum) {
    const { canvas, ctx, dpr } = this;
    if (!canvas.width || !spectrum) return;
    const w = canvas.width;
    const h = canvas.height;
    const step = Math.round(this.colPx * dpr);
    // 'copy' replaces pixels instead of blending over the old frame.
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(canvas, step, 0, w - step, h, 0, 0, w - step, h);
    ctx.restore();
    ctx.clearRect(w - step, 0, step, h);
    const rows = spectrum.length;
    const rowH = h / rows;
    ctx.fillStyle = this.color;
    // Draw each bin against this column's median, so background noise fades
    // out and only tones that stand above it show.
    const dbs = Array.from(spectrum, (v) => 10 * Math.log10(v || 1));
    const median = [...dbs].sort((a, b) => a - b)[rows >> 1];
    for (let i = 0; i < rows; i++) {
      const a = Math.max(0, Math.min(1, (dbs[i] - median - 5) / 12));
      if (a < 0.04) continue;
      ctx.globalAlpha = a;
      // Low tones at the bottom, like a musical staff.
      ctx.fillRect(w - step, h - (i + 1) * rowH + 0.5, step, Math.max(1, rowH - 1));
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.ro.disconnect();
  }
}

export function slotsHtml(n = 12) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<span class="slot" data-i="${i}"><i></i></span>`;
  return `<div class="slots" aria-hidden="true">${s}</div>`;
}

export function setSlot(root, i, value, confidence) {
  const el = root.querySelector(`.slot[data-i="${i}"]`);
  if (!el) return;
  el.style.setProperty('--v', String(value / 15));
  el.classList.add('on');
  el.classList.toggle('weak', confidence < 0.65);
}

export function clearSlots(root) {
  root.querySelectorAll('.slot').forEach((el) => el.classList.remove('on', 'weak'));
}
