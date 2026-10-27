// Microphone to Demodulator.

import { Demodulator } from '../modem/demod.js';

export class MicError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // insecure | unsupported | denied | no_device | busy
    this.cause = cause;
  }
}

export async function startReceiver(callbacks) {
  if (!window.isSecureContext) throw new MicError('insecure');
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported');
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new MicError('unsupported');

  // Create the context first, inside the tap, so iOS lets it run.
  const ctx = new Ctx({ latencyHint: 'interactive' });
  ctx.resume?.();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Voice processing removes exactly the tones we want to hear.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    ctx.close();
    const name = e?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', e);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('no_device', e);
    if (name === 'NotReadableError' || name === 'AbortError') throw new MicError('busy', e);
    throw new MicError('unsupported', e);
  }

  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const demod = new Demodulator({ sampleRate: ctx.sampleRate, ...callbacks });
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  let node;
  if (ctx.audioWorklet) {
    await ctx.audioWorklet.addModule('/js/lib/tap-worklet.js');
    node = new AudioWorkletNode(ctx, 'earshot-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => demod.push(e.data);
  } else {
    // Older Safari.
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => demod.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  source.connect(node);
  node.connect(sink);

  return {
    demod,
    sampleRate: ctx.sampleRate,
    stop() {
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already gone */
      }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    },
  };
}
