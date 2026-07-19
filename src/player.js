/* Playback and rendering. A lookahead scheduler drives live audio so that
   edits, mutes and solos take effect while sound is playing; the offline
   renderer walks the same event function so a download matches what he heard. */

const LOOKAHEAD = 0.18;   // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;

const Player = {
  ctx: null,
  graph: null,
  buffers: {},          // birdKey -> [AudioBuffer]
  song: null,
  mode: "song",         // "song" plays once, "loop" repeats a pattern
  playing: false,
  startTime: 0,
  nextStep: 0,
  timer: null,
  laneGains: {},
  onStep: null,
  onEnd: null,
  _lastUiStep: -1,

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    return this.ctx;
  },

  async resume() {
    this.init();
    if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch (e) {} }
  },

  stepDur(song) { return 60 / song.bpm / 4; },

  /* Swing delays every second 16th, which is most of the groove. */
  stepTime(song, absStep) {
    const d = this.stepDur(song);
    let t = absStep * d;
    if (absStep % 2 === 1) t += song.swing * d * 0.6;
    return t;
  },

  totalSteps(song) { return song.bars * STEPS_PER_BAR; },

  buildFor(song, ctx, graph) {
    const gains = {};
    for (const lane of song.lanes) {
      const g = ctx.createGain();
      g.gain.value = lane.muted ? 0 : lane.gain;
      g.connect(graph.dry);
      const rev = ctx.createGain(); rev.gain.value = 0.35;
      g.connect(rev); rev.connect(graph.revSend);
      const del = ctx.createGain(); del.gain.value = 0.3;
      g.connect(del); del.connect(graph.delSend);
      gains[lane.id] = g;
    }
    return gains;
  },

  applySolo() {
    if (!this.song) return;
    const anySolo = this.song.lanes.some((l) => l.solo);
    for (const lane of this.song.lanes) {
      const g = this.laneGains[lane.id];
      if (!g) continue;
      const on = anySolo ? lane.solo && !lane.muted : !lane.muted;
      g.gain.setTargetAtTime(on ? lane.gain : 0, this.ctx.currentTime, 0.02);
    }
  },

  bufferFor(birdKey, clipIdx) {
    const list = this.buffers[birdKey];
    if (!list || !list.length) return null;
    return list[clipIdx % list.length] || list[0];
  },

  scheduleEvents(ctx, graph, laneGains, events, t, song) {
    for (const ev of events) {
      switch (ev.type) {
        case "kick":  kick(graph, t, ev.gain); break;
        case "snare": snare(graph, t, ev.gain); break;
        case "hat":   hat(graph, t, ev.gain, ev.open); break;
        case "bass":  bass(graph, t, ev.midi, ev.dur, ev.gain); break;
        case "pad":   pad(graph, t, ev.midis, ev.dur, ev.gain); break;
        case "pluck": pluck(graph, t, ev.midi, 0.16, ev.gain); break;
        case "bird": {
          const buf = this.bufferFor(ev.birdKey, ev.clip);
          if (!buf) break;
          bird(graph, buf, t, {
            semitones: ev.semitones,
            gain: ev.gain,
            pan: ev.pan,
            laneGain: laneGains[ev.lane] || null,
            maxDur: this.stepDur(song) * 8,
          });
          break;
        }
      }
    }
  },

  play(song, mode = "song") {
    this.stop();
    this.init();
    this.song = song;
    this.mode = mode;
    this.graph = buildGraph(this.ctx, { reverb: song.reverb, delay: song.delay });
    this.laneGains = this.buildFor(song, this.ctx, this.graph);
    this.applySolo();
    this.playing = true;
    this.nextStep = 0;
    this.startTime = this.ctx.currentTime + 0.12;
    this._lastUiStep = -1;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  },

  tick() {
    if (!this.playing || !this.song) return;
    const song = this.song;
    const total = this.totalSteps(song);
    const now = this.ctx.currentTime;

    while (true) {
      const t = this.startTime + this.stepTime(song, this.nextStep);
      if (t >= now + LOOKAHEAD) break;
      if (this.mode === "song" && this.nextStep >= total) {
        // Let the reverb tail ring out before declaring the song over.
        if (now > t + 1.5) this.finish();
        break;
      }
      const idx = this.mode === "loop" ? this.nextStep % total : this.nextStep;
      this.scheduleEvents(this.ctx, this.graph, this.laneGains,
                          eventsFor(song, idx), t, song);
      this.nextStep++;
    }

    if (this.onStep) {
      const elapsed = now - this.startTime;
      const cur = Math.max(0, Math.floor(elapsed / this.stepDur(song)));
      const shown = this.mode === "loop" ? cur % total : Math.min(cur, total);
      if (shown !== this._lastUiStep) {
        this._lastUiStep = shown;
        this.onStep(shown, total);
      }
    }
  },

  finish() {
    this.playing = false;
    clearInterval(this.timer); this.timer = null;
    if (this.onEnd) this.onEnd();
  },

  stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.graph) {
      // Fade the master out fast so stopping never clicks.
      try {
        const g = this.graph.master.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setTargetAtTime(0, this.ctx.currentTime, 0.015);
        const old = this.graph;
        setTimeout(() => { try { old.master.disconnect(); } catch (e) {} }, 250);
      } catch (e) {}
      this.graph = null;
    }
    this.laneGains = {};
  },

  /* One-off preview used by the sound library and the sequencer grid. */
  preview(birdKey, clipIdx = 0, semitones = 0) {
    this.init();
    this.resume();
    const buf = this.bufferFor(birdKey, clipIdx);
    if (!buf) return;
    if (!this._pvGraph) this._pvGraph = buildGraph(this.ctx, { reverb: 0.22, delay: 0.12 });
    bird(this._pvGraph, buf, this.ctx.currentTime + 0.01,
         { semitones, gain: 0.95, pan: 0 });
  },

  /* Offline render for downloads. Same events, same voices, no live clock. */
  async render(song) {
    const sr = this.ctx ? this.ctx.sampleRate : 44100;
    const dur = song.seconds + 3.0;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(2, Math.ceil(dur * sr), sr);
    const graph = buildGraph(off, { reverb: song.reverb, delay: song.delay });
    const laneGains = this.buildFor(song, off, graph);
    const anySolo = song.lanes.some((l) => l.solo);
    for (const lane of song.lanes) {
      const on = anySolo ? lane.solo && !lane.muted : !lane.muted;
      laneGains[lane.id].gain.value = on ? lane.gain : 0;
    }
    const total = this.totalSteps(song);
    for (let s = 0; s < total; s++) {
      const t = 0.05 + this.stepTime(song, s);
      this.scheduleEvents(off, graph, laneGains, eventsFor(song, s), t, song);
    }
    const buf = await off.startRendering();
    return encodeWav(buf);
  },
};

/* 16-bit PCM WAV so the download opens anywhere without a codec. */
function encodeWav(audioBuffer) {
  const nCh = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(audioBuffer.getChannelData(c));

  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  wstr(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, nCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * nCh * 2, true);
  view.setUint16(32, nCh * 2, true);
  view.setUint16(34, 16, true);
  wstr(36, "data");
  view.setUint32(40, len * nCh * 2, true);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

/* Happy Birthday, played on a bird. Public domain melody, so it can ship.
   [semitones from tonic, beats] */
const BIRTHDAY = [
  [-5, 0.5], [-5, 0.5], [-3, 1], [-5, 1], [0, 1], [-1, 2],
  [-5, 0.5], [-5, 0.5], [-3, 1], [-5, 1], [2, 1], [0, 2],
  [-5, 0.5], [-5, 0.5], [7, 1], [4, 1], [0, 1], [-1, 1], [-3, 2],
  [5, 0.5], [5, 0.5], [4, 1], [0, 1], [2, 1], [0, 2],
];

async function playBirthday(birdKey, clipIdx = 0) {
  await Player.resume();
  const ctx = Player.ctx;
  const buf = Player.bufferFor(birdKey, clipIdx);
  const graph = buildGraph(ctx, { reverb: 0.34, delay: 0.18 });
  const bpm = 146;
  const beat = 60 / bpm;
  let t = ctx.currentTime + 0.15;
  const root = 52;
  // A soft chord bed under the melody so it reads as music, not beeping.
  pad(graph, t, [root, root + 7, root + 12], BIRTHDAY.reduce((a, n) => a + n[1], 0) * beat, 0.07);
  for (const [semi, beats] of BIRTHDAY) {
    if (buf) {
      bird(graph, buf, t, { semitones: semi + 4, gain: 0.95, pan: 0, maxDur: beat * beats * 1.6 });
    } else {
      pluck(graph, t, root + 24 + semi, beat * beats * 0.9, 0.2);
    }
    pluck(graph, t, root + 12 + semi, Math.min(0.5, beat * beats * 0.8), 0.05);
    t += beat * beats;
  }
  return (t - ctx.currentTime) * 1000;
}
