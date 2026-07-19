/* sound_bird_ audio engine
   One event model drives three things: live playback, the step sequencer,
   and offline WAV rendering. Anything scheduled here sounds identical in all
   three, because they all consume eventsForStep(). */

const STEPS_PER_BAR = 16;
const PENTA = [0, 2, 4, 7, 9];          // major pentatonic, safe under random pitching
const SCALE_MINOR_PENTA = [0, 3, 5, 7, 10];

/* ---------- seeded randomness so a track name + seed always rebuilds the song ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = {
  r: Math.random,
  seed(s) { this.r = mulberry32(s >>> 0); },
  f(a = 1, b = 0) { return b + this.r() * (a - b); },
  i(n) { return Math.floor(this.r() * n); },
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; },
  chance(p) { return this.r() < p; },
};

/* Euclidean rhythms distribute k hits over n steps as evenly as possible.
   They are why generated patterns feel deliberate instead of scattered. */
function euclid(k, n, rotate = 0) {
  if (k <= 0) return new Array(n).fill(0);
  if (k >= n) return new Array(n).fill(1);
  const pat = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) { bucket -= n; pat.push(1); } else pat.push(0);
  }
  if (rotate) {
    const r = ((rotate % n) + n) % n;
    return pat.slice(r).concat(pat.slice(0, r));
  }
  return pat;
}

/* ---------- mood presets ---------- */
/* The birds are the song; the band is the accompaniment. `support` scales
   everything synthesised, `birdGain` scales the calls, and `maxPerStep` caps
   how many birds may land on one step. That cap is what keeps a fast, busy
   setting sounding like a beat rather than a pile of noise: without space
   between hits there is no pulse to hear.
   `clipSteps` bounds how long a single call may ring, in sixteenths, so calls
   stop before the next one lands instead of smearing across the bar. */
const MOODS = {
  chill: {
    bpm: [90, 104], swing: 0.14, drumDensity: 0.4, birdDensity: 0.5,
    reverb: 0.42, delay: 0.28, maxLanes: 5, pitchRange: [-4, 7],
    scale: SCALE_MINOR_PENTA, arp: 0.15, clipSteps: 8,
    support: 0.66, birdGain: 1.25, maxPerStep: 2, label: "chill",
  },
  upbeat: {
    bpm: [122, 136], swing: 0.09, drumDensity: 0.58, birdDensity: 0.75,
    reverb: 0.26, delay: 0.3, maxLanes: 7, pitchRange: [-5, 10],
    scale: PENTA, arp: 0.3, clipSteps: 5,
    support: 0.7, birdGain: 1.2, maxPerStep: 2, label: "upbeat",
  },
  chaos: {
    bpm: [138, 156], swing: 0.05, drumDensity: 0.72, birdDensity: 0.9,
    reverb: 0.2, delay: 0.4, maxLanes: 9, pitchRange: [-7, 12],
    scale: PENTA, arp: 0.35, clipSteps: 4,
    support: 0.64, birdGain: 1.25, maxPerStep: 3, label: "chaos",
  },
};

/* ---------- graph ---------- */
function makeImpulse(ctx, seconds = 2.2, decay = 3.2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* A tanh curve used as a soft limiter. WaveShaper clamps anything beyond the
   curve's input range, so peaks approach full scale smoothly instead of
   clipping square. Without this a busy flock drives the mix past 0 dBFS. */
function makeSoftClip(ctx) {
  const ws = ctx.createWaveShaper();
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1.6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  ws.curve = curve;
  ws.oversample = "2x";
  return ws;
}

function buildGraph(ctx, opts = {}) {
  const master = ctx.createGain();
  // Leaving more space between hits lowered the average level, so the master
  // comes up to compensate. The limiter downstream still caps the peaks.
  master.gain.value = opts.master ?? 0.86;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 20;
  comp.ratio.value = 4.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;

  const limiter = makeSoftClip(ctx);
  const out = ctx.createGain();
  out.gain.value = 0.92;                 // leaves roughly a decibel of headroom

  master.connect(comp).connect(limiter).connect(out).connect(ctx.destination);

  const dry = ctx.createGain(); dry.gain.value = 1; dry.connect(master);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const revSend = ctx.createGain(); revSend.gain.value = opts.reverb ?? 0.25;
  const revOut = ctx.createGain(); revOut.gain.value = 0.9;
  revSend.connect(reverb).connect(revOut).connect(master);

  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = opts.delayTime ?? 0.32;
  const fb = ctx.createGain(); fb.gain.value = 0.36;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = "highpass"; delayTone.frequency.value = 420;
  const delSend = ctx.createGain(); delSend.gain.value = opts.delay ?? 0.28;
  delSend.connect(delay); delay.connect(delayTone).connect(fb).connect(delay);
  delayTone.connect(master);

  return { ctx, master, dry, revSend, delSend, comp };
}

/* ---------- voices ---------- */
function kick(g, t, gain = 1) {
  const { ctx } = g;
  const o = ctx.createOscillator(); const vca = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(43, t + 0.13);
  vca.gain.setValueAtTime(gain, t);
  vca.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(vca).connect(g.dry);
  const click = ctx.createOscillator(); const cg = ctx.createGain();
  click.type = "square"; click.frequency.setValueAtTime(880, t);
  cg.gain.setValueAtTime(gain * 0.12, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  click.connect(cg).connect(g.dry);
  o.start(t); o.stop(t + 0.36); click.start(t); click.stop(t + 0.03);
}

/* One second of noise, generated once per context and reused by every snare
   and hat with a random read offset. Filling a fresh buffer per hit cost
   millions of Math.random calls across a rendered track. */
function noiseBuf(ctx) {
  if (!ctx.__noise) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    ctx.__noise = b;
  }
  return ctx.__noise;
}

function snare(g, t, gain = 0.7) {
  const { ctx } = g;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx);
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
  bp.frequency.value = 1900; bp.Q.value = 0.9;
  const vca = ctx.createGain();
  vca.gain.setValueAtTime(gain, t);
  vca.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
  src.connect(bp).connect(vca); vca.connect(g.dry); vca.connect(g.revSend);
  src.start(t, Math.random() * 0.6);
  src.stop(t + 0.24);
  const body = ctx.createOscillator(); const bg = ctx.createGain();
  body.type = "triangle"; body.frequency.setValueAtTime(210, t);
  body.frequency.exponentialRampToValueAtTime(140, t + 0.1);
  bg.gain.setValueAtTime(gain * 0.5, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  body.connect(bg).connect(g.dry);
  body.start(t); body.stop(t + 0.15);
}

function hat(g, t, gain = 0.3, open = false) {
  const { ctx } = g;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx);
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7200;
  const vca = ctx.createGain();
  vca.gain.setValueAtTime(gain, t);
  vca.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.3 : 0.055));
  src.connect(hp).connect(vca).connect(g.dry);
  src.start(t, Math.random() * 0.6); src.stop(t + (open ? 0.42 : 0.14));
}

function bass(g, t, midi, dur = 0.22, gain = 0.5) {
  const { ctx } = g;
  const o = ctx.createOscillator(); o.type = "sawtooth";
  const sub = ctx.createOscillator(); sub.type = "sine";
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  o.frequency.setValueAtTime(f, t);
  sub.frequency.setValueAtTime(f / 2, t);
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
  lp.frequency.setValueAtTime(180, t);
  lp.frequency.exponentialRampToValueAtTime(1500, t + 0.03);
  lp.frequency.exponentialRampToValueAtTime(320, t + dur);
  lp.Q.value = 6;
  const vca = ctx.createGain();
  vca.gain.setValueAtTime(0.0001, t);
  vca.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vca.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); sub.connect(lp); lp.connect(vca).connect(g.dry);
  o.start(t); sub.start(t); o.stop(t + dur + 0.05); sub.stop(t + dur + 0.05);
}

function pad(g, t, midis, dur = 2.0, gain = 0.12) {
  const { ctx } = g;
  midis.forEach((m, i) => {
    const o = ctx.createOscillator();
    o.type = i % 2 ? "triangle" : "sawtooth";
    const f = 440 * Math.pow(2, (m - 69) / 12);
    o.frequency.setValueAtTime(f, t);
    o.detune.setValueAtTime((i - 1) * 6, t);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(1800, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0.0001, t);
    vca.gain.linearRampToValueAtTime(gain, t + Math.min(0.6, dur * 0.3));
    vca.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(vca);
    vca.connect(g.dry); vca.connect(g.revSend);
    o.start(t); o.stop(t + dur + 0.05);
  });
}

function pluck(g, t, midi, dur = 0.18, gain = 0.16) {
  const { ctx } = g;
  const o = ctx.createOscillator(); o.type = "square";
  o.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), t);
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
  lp.frequency.setValueAtTime(4200, t);
  lp.frequency.exponentialRampToValueAtTime(900, t + dur);
  const vca = ctx.createGain();
  vca.gain.setValueAtTime(0.0001, t);
  vca.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  vca.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp).connect(vca);
  vca.connect(g.dry); vca.connect(g.delSend);
  o.start(t); o.stop(t + dur + 0.03);
}

/* The bird itself. Pitch is playbackRate, so a chirp shifted up also gets
   shorter and brighter, which is most of the character of these remixes. */
function bird(g, buf, t, opts = {}) {
  if (!buf) return;
  const { ctx } = g;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const semis = opts.semitones ?? 0;
  src.playbackRate.value = Math.pow(2, semis / 12);
  const vca = ctx.createGain();
  vca.gain.value = opts.gain ?? 0.9;
  let node = src;
  if (opts.filter) {
    const f = ctx.createBiquadFilter();
    f.type = opts.filter; f.frequency.value = opts.filterFreq ?? 1200;
    f.Q.value = 0.8;
    node.connect(f); node = f;
  }
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) {
    panner.pan.value = opts.pan ?? 0;
    node.connect(panner); node = panner;
  }
  node.connect(vca);
  const laneGain = opts.laneGain || null;
  if (laneGain) {
    vca.connect(laneGain);
  } else {
    vca.connect(g.dry);
    if (opts.reverbSend !== 0) vca.connect(g.revSend);
    if (opts.delaySend) vca.connect(g.delSend);
  }
  // Trim very long clips so a single call cannot smear over the beat.
  const maxDur = opts.maxDur ?? 0;
  const dur = buf.duration / src.playbackRate.value;
  if (maxDur && dur > maxDur) {
    vca.gain.setValueAtTime(opts.gain ?? 0.9, t + maxDur - 0.05);
    vca.gain.exponentialRampToValueAtTime(0.0001, t + maxDur);
    src.start(t); src.stop(t + maxDur + 0.02);
  } else {
    src.start(t);
  }
  return src;
}

/* Scripts share global lexical scope, so no module exports: the build step
   concatenates these files and the page must also run from file://. */
