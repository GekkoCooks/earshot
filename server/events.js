// Server-sent events for the lecturer's live view.

export class Hub {
  constructor() {
    this.channels = new Map();
    this.timer = setInterval(() => this.broadcastRaw(': ping\n\n'), 20_000);
    this.timer.unref();
  }

  subscribe(channel, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(res);
    res.on('close', () => {
      const set = this.channels.get(channel);
      set?.delete(res);
      if (set?.size === 0) this.channels.delete(channel);
    });
  }

  publish(channel, event, data) {
    const set = this.channels.get(channel);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(msg);
  }

  broadcastRaw(msg) {
    for (const set of this.channels.values()) for (const res of set) res.write(msg);
  }

  close() {
    clearInterval(this.timer);
    for (const set of this.channels.values()) for (const res of set) res.end();
    this.channels.clear();
  }
}
