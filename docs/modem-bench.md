# Modem benchmark (simulated room)

Output of `npm run bench -- 12` on 2026-10-27. Each row is 12 runs. A run is one 8 second window of a single code, through a simulated room: Schroeder reverb at the given RT60, speaker roll-off (quiet band only), 0 to 200 ppm clock drift, white noise, and speech-like babble on the audible band. **SNR is measured inside the band's 2 kHz**, not across the whole spectrum. "caught %" is how often the listener decoded the right code within the window; "median s" is time from the start of transmission; "false" counts wrong codes accepted.

```
┌─────────┬───────────┬──────┬────────┬──────────┬──────────┬───────┐
│ (index) │ band      │ rt60 │ snr dB │ caught % │ median s │ false │
├─────────┼───────────┼──────┼────────┼──────────┼──────────┼───────┤
│ 0       │ 'quiet'   │ 0.4  │ -12    │ 0        │ '-'      │ 0     │
│ 1       │ 'quiet'   │ 0.4  │ -9     │ 83       │ '6.4'    │ 0     │
│ 2       │ 'quiet'   │ 0.4  │ -6     │ 100      │ '3.2'    │ 0     │
│ 3       │ 'quiet'   │ 0.4  │ -3     │ 100      │ '3.2'    │ 0     │
│ 4       │ 'quiet'   │ 0.4  │ 0      │ 100      │ '3.2'    │ 0     │
│ 5       │ 'quiet'   │ 0.4  │ 6      │ 100      │ '3.2'    │ 0     │
│ 6       │ 'quiet'   │ 0.8  │ -12    │ 0        │ '-'      │ 0     │
│ 7       │ 'quiet'   │ 0.8  │ -9     │ 83       │ '4.9'    │ 0     │
│ 8       │ 'quiet'   │ 0.8  │ -6     │ 100      │ '3.2'    │ 0     │
│ 9       │ 'quiet'   │ 0.8  │ -3     │ 100      │ '3.2'    │ 0     │
│ 10      │ 'quiet'   │ 0.8  │ 0      │ 100      │ '3.2'    │ 0     │
│ 11      │ 'quiet'   │ 0.8  │ 6      │ 100      │ '3.2'    │ 0     │
│ 12      │ 'quiet'   │ 1.2  │ -12    │ 8        │ '8.0'    │ 0     │
│ 13      │ 'quiet'   │ 1.2  │ -9     │ 42       │ '4.8'    │ 0     │
│ 14      │ 'quiet'   │ 1.2  │ -6     │ 100      │ '3.2'    │ 0     │
│ 15      │ 'quiet'   │ 1.2  │ -3     │ 100      │ '3.2'    │ 0     │
│ 16      │ 'quiet'   │ 1.2  │ 0      │ 100      │ '3.2'    │ 0     │
│ 17      │ 'quiet'   │ 1.2  │ 6      │ 100      │ '3.2'    │ 0     │
│ 18      │ 'audible' │ 0.4  │ -12    │ 8        │ '3.2'    │ 0     │
│ 19      │ 'audible' │ 0.4  │ -9     │ 92       │ '4.8'    │ 0     │
│ 20      │ 'audible' │ 0.4  │ -6     │ 100      │ '3.2'    │ 0     │
│ 21      │ 'audible' │ 0.4  │ -3     │ 100      │ '3.2'    │ 0     │
│ 22      │ 'audible' │ 0.4  │ 0      │ 100      │ '3.2'    │ 0     │
│ 23      │ 'audible' │ 0.4  │ 6      │ 100      │ '3.2'    │ 0     │
│ 24      │ 'audible' │ 0.8  │ -12    │ 0        │ '-'      │ 0     │
│ 25      │ 'audible' │ 0.8  │ -9     │ 100      │ '6.4'    │ 0     │
│ 26      │ 'audible' │ 0.8  │ -6     │ 100      │ '3.2'    │ 0     │
│ 27      │ 'audible' │ 0.8  │ -3     │ 100      │ '3.2'    │ 0     │
│ 28      │ 'audible' │ 0.8  │ 0      │ 100      │ '3.2'    │ 0     │
│ 29      │ 'audible' │ 0.8  │ 6      │ 100      │ '3.2'    │ 0     │
│ 30      │ 'audible' │ 1.2  │ -12    │ 0        │ '-'      │ 0     │
│ 31      │ 'audible' │ 1.2  │ -9     │ 42       │ '4.8'    │ 0     │
│ 32      │ 'audible' │ 1.2  │ -6     │ 100      │ '3.2'    │ 0     │
│ 33      │ 'audible' │ 1.2  │ -3     │ 100      │ '3.2'    │ 0     │
│ 34      │ 'audible' │ 1.2  │ 0      │ 100      │ '3.2'    │ 0     │
│ 35      │ 'audible' │ 1.2  │ 6      │ 100      │ '3.2'    │ 0     │
└─────────┴───────────┴──────┴────────┴──────────┴──────────┴───────┘
```

The median of 3.2 s is two frames: the first frame is spent settling the noise floor because the recording starts exactly as the tones start. A phone that starts listening mid-transmission usually catches the next full frame, 1.6 to 3.2 s later.

This is a simulation. Real rooms add things it does not model: speaker distortion, phone microphone roll-off above 16 kHz on some models, people moving, and browser audio processing that ignores the constraints we ask for.
