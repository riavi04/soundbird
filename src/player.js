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

  /* Fire the visual callback when audio time reaches t. Timers are tracked so
     stopping playback does not leave faces popping up afterwards. */
  popTimers: [],
  notePop(birdKey, t) {
    const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
    const id = setTimeout(() => {
      if (this.onBird) this.onBird(birdKey);
    }, delay);
    this.popTimers.push(id);
    if (this.popTimers.length > 400) {
      this.popTimers = this.popTimers.filter((x) => x !== id).concat(id);
    }
  },

  clearPopTimers() {
    for (const id of this.popTimers) clearTimeout(id);
    this.popTimers = [];
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
          // Show the face at the moment the call is heard, not when it was
          // scheduled. Skipped during offline rendering, which has no clock.
          if (this.onBird && ctx === this.ctx) {
            this.notePop(ev.birdKey, t);
          }
          bird(graph, buf, t, {
            semitones: ev.semitones,
            gain: ev.gain,
            pan: ev.pan,
            laneGain: laneGains[ev.lane] || null,
            // Generated songs bound a call so it stops before the next lands,
            // which is what keeps a busy arrangement from smearing. The composer
            // does not: a hit there is placed deliberately, so it rings its full
            // natural length, and a pitched-down sound is as long and dragged
            // out as it is when previewed on its own.
            maxDur: song.kind === "pattern"
              ? 0
              : this.stepDur(song) * (song.clipSteps || 6),
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
    this.clearPopTimers();
    if (this.onStopped) this.onStopped();
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

  /* Fade whatever preview is currently sounding. Lets a new preview cut the
     last one instead of piling on top, which matters when sweeping the mouse
     down the favorites menu. */
  previewCut() {
    if (this._pvBus) {
      try {
        const g = this._pvBus.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
      } catch (e) {}
      this._pvBus = null;
    }
  },

  /* One-off preview used by the sound library and the sequencer grid. Routed
     through a per-preview bus so previewCut can silence it. */
  preview(birdKey, clipIdx = 0, semitones = 0) {
    this.init();
    this.resume();
    const buf = this.bufferFor(birdKey, clipIdx);
    if (!buf) return;
    if (!this._pvGraph) this._pvGraph = buildGraph(this.ctx, { reverb: 0.22, delay: 0.12 });
    this.previewCut();
    const bus = this.ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this._pvGraph.dry);
    const rev = this.ctx.createGain();
    rev.gain.value = 0.3;
    bus.connect(rev); rev.connect(this._pvGraph.revSend);
    this._pvBus = bus;
    bird(this._pvGraph, buf, this.ctx.currentTime + 0.01,
         { semitones, gain: 0.95, pan: 0, laneGain: bus });
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

/* Happy Birthday, shared out among seven birds. Public domain melody.
   The piha and loon take the two quick pickup notes that open each line,
   which turns the song into call and response, and the three-wattled
   bellbird's metallic bonk gets the high note because it is the moment worth
   marking. Every bird here sits within about four semitones of the shared
   reference, so carrying the melody costs them little of their own character.
   [semitones from tonic, beats, index into TUNE_BIRDS] */
const TUNE_BIRDS = ["piha", "penguin", "kookaburra", "loon",
                    "bellbird3", "ptarmigan", "quetzal"];

const BIRTHDAY = [
  [-5, 0.5, 0], [-5, 0.5, 0], [-3, 1, 1], [-5, 1, 1], [0, 1, 1], [-1, 2, 1],
  [-5, 0.5, 0], [-5, 0.5, 0], [-3, 1, 2], [-5, 1, 2], [2, 1, 2], [0, 2, 2],
  [-5, 0.5, 3], [-5, 0.5, 3], [7, 1, 4], [4, 1, 5], [0, 1, 5], [-1, 1, 5], [-3, 2, 5],
  [5, 0.5, 3], [5, 0.5, 3], [4, 1, 6], [0, 1, 6], [2, 1, 6], [0, 2, 6],
];

/* Pick the clip whose natural pitch is closest to the common reference, so
   the transposition needed is as small as possible and the call still sounds
   like the animal that made it. */
function tuneVoice(key) {
  const list = Player.buffers[key];
  if (!list || !list.length) return null;
  const meta = (window.BIRD_DATA || {})[key];
  let index = 0, best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const off = Math.abs((meta && meta.clips[i] && meta.clips[i].tune_offset) || 0);
    if (off < best) { best = off; index = i; }
  }
  const offset = (meta && meta.clips[index] && meta.clips[index].tune_offset) || 0;
  return { key, index, offset };
}

async function playBirthday() {
  await Player.resume();
  const ctx = Player.ctx;
  const graph = buildGraph(ctx, { reverb: 0.32, delay: 0.14 });
  const bpm = 132;
  const beat = 60 / bpm;
  const root = 52;

  const fallback = Object.keys(Player.buffers)[0];
  const voices = TUNE_BIRDS.map((k) =>
    (Player.buffers[k] && Player.buffers[k].length) ? tuneVoice(k)
      : (fallback ? tuneVoice(fallback) : null));
  // Everyone who sang gets to appear together on the closing note.
  const finale = [];
  for (const v of voices) {
    if (v && !finale.some((f) => f.key === v.key)) finale.push(v);
  }

  Player.clearPopTimers();
  let t = ctx.currentTime + 0.15;
  const total = BIRTHDAY.reduce((a, n) => a + n[1], 0) * beat;
  // A soft chord bed under the melody so it reads as music, not beeping.
  pad(graph, t, [root, root + 7, root + 12], total, 0.06);

  BIRTHDAY.forEach(([semi, beats, slot], i) => {
    const dur = beats * beat;
    const last = i === BIRTHDAY.length - 1;
    const singing = last ? finale : [voices[slot]].filter(Boolean);
    singing.forEach((v, vi) => {
      const buf = Player.bufferFor(v.key, v.index);
      if (!buf) return;
      bird(graph, buf, t, {
        semitones: semi + v.offset,
        gain: last ? 0.55 : 0.95,
        pan: last && singing.length > 1 ? (vi / (singing.length - 1)) * 0.9 - 0.45 : 0,
        // Each note is trimmed to its own length so the melody stays in time
        // however long the underlying call happens to be.
        maxDur: dur * (last ? 2.4 : 1.06),
      });
      if (Player.onBird) Player.notePop(v.key, t);
    });
    pluck(graph, t, root + 12 + semi, Math.min(0.4, dur * 0.8), 0.04);
    t += dur;
  });
  return (t - ctx.currentTime) * 1000;
}
