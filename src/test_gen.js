/* Headless check on the song logic: no audio, just the event stream.
   Run: node src/test_gen.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = __dirname;
// Top-level const lives in the global lexical scope, not on the context
// object, so re-expose the few values the test needs to read directly.
const code = ["engine.js", "generate.js"]
  .map((f) => fs.readFileSync(path.join(SRC, f), "utf8"))
  .join("\n") + "\n;globalThis.STEPS_PER_BAR = STEPS_PER_BAR; globalThis.MOODS = MOODS; globalThis.sectionAt = sectionAt;";

const ctx = { console, Math, window: {}, performance: { now: () => 0 } };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const manifestPath = path.join(SRC, "..", "assets", "clips", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pool = Object.entries(manifest).map(([k, v]) => ({
  key: k, common: v.common, clipCount: v.clips.length,
}));

let fails = 0;
const check = (cond, msg) => { if (!cond) { console.log("  FAIL " + msg); fails++; } };

console.log(`pool: ${pool.length} birds\n`);

for (const mood of ["chill", "upbeat", "chaos"]) {
  const stats = [];
  for (let trial = 0; trial < 40; trial++) {
    const song = ctx.generateSong(null, mood, pool);
    const total = song.bars * ctx.STEPS_PER_BAR;
    let counts = { kick: 0, snare: 0, hat: 0, bass: 0, pad: 0, pluck: 0, bird: 0 };
    const usedLanes = new Set();
    // Rhythm and balance: how crowded any one step gets, whether bars start
    // with a bird, and how loud the birds are next to the backing.
    let maxPerStep = 0, birdGain = 0, supportGain = 0;
    let barsWithDownbeatBird = 0, mainBars = 0;
    for (let s = 0; s < total; s++) {
      const evs = ctx.eventsFor(song, s);
      const birdsHere = evs.filter((e) => e.type === "bird");
      if (birdsHere.length > maxPerStep) maxPerStep = birdsHere.length;
      for (const e of evs) {
        if (e.type === "bird") birdGain += e.gain;
        else if (e.type !== "pad") supportGain += e.gain;
      }
      if (s % 16 === 0) {
        const bar = s / 16;
        const sec = ctx.sectionAt(song, bar);
        if (sec.intensity >= 0.9) {
          mainBars++;
          if (birdsHere.length) barsWithDownbeatBird++;
        }
      }
      for (const e of evs) {
        counts[e.type] = (counts[e.type] || 0) + 1;
        if (e.type === "bird") {
          usedLanes.add(e.lane);
          check(Number.isFinite(e.semitones), `${mood}: non-finite semitone`);
          check(e.semitones >= -24 && e.semitones <= 24, `${mood}: wild pitch ${e.semitones}`);
          check(e.gain > 0 && e.gain <= 1.6, `${mood}: odd bird gain ${e.gain}`);
          check(Math.abs(e.pan) <= 1, `${mood}: pan out of range ${e.pan}`);
        }
        if (e.type === "bass" || e.type === "pluck") {
          check(Number.isFinite(e.midi) && e.midi > 12 && e.midi < 108,
                `${mood}: midi out of range ${e.midi}`);
        }
      }
    }
    check(song.seconds > 40 && song.seconds < 95, `${mood}: length ${song.seconds.toFixed(1)}s`);
    check(counts.kick > 10, `${mood}: too few kicks (${counts.kick})`);
    check(counts.bird > 20, `${mood}: too few bird hits (${counts.bird})`);
    check(usedLanes.size >= 2, `${mood}: only ${usedLanes.size} lanes sounded`);
    check(song.name && song.name.length > 3, `${mood}: bad track name`);

    // The rhythm guarantees. A cap that is exceeded, or bars that do not start
    // with a bird, is what "no beat" sounded like.
    const cap = ctx.MOODS[mood].maxPerStep;
    check(maxPerStep <= cap, `${mood}: ${maxPerStep} birds on one step, cap is ${cap}`);
    const downbeat = mainBars ? barsWithDownbeatBird / mainBars : 1;
    check(downbeat >= 0.8, `${mood}: only ${(downbeat * 100).toFixed(0)}% of main bars open on a bird`);
    check(birdGain > supportGain, `${mood}: backing (${supportGain.toFixed(0)}) louder than birds (${birdGain.toFixed(0)})`);

    // Variety: the song must not be one bird's theme from start to finish.
    const leads = new Set();
    let everSounded = new Set();
    for (const roles of song.schedule) {
      for (const [id, r] of Object.entries(roles)) {
        everSounded.add(id);
        if (r === "lead") leads.add(id);
      }
    }
    check(leads.size >= 3, `${mood}: only ${leads.size} bird(s) ever lead a section`);
    check(everSounded.size >= Math.min(4, song.lanes.length),
          `${mood}: only ${everSounded.size} of ${song.lanes.length} birds get a part`);

    stats.push({ secs: song.seconds, bpm: song.bpm, birds: counts.bird,
                 leads: leads.size, parts: everSounded.size,
                 drums: counts.kick + counts.snare + counts.hat, lanes: usedLanes.size,
                 maxStep: maxPerStep, ratio: birdGain / Math.max(1, supportGain),
                 downbeat });
  }
  const avg = (k) => (stats.reduce((a, s) => a + s[k], 0) / stats.length).toFixed(1);
  console.log(`${mood.padEnd(7)} len ${avg("secs")}s  bpm ${avg("bpm")}  ` +
              `birdhits ${avg("birds")}  drumhits ${avg("drums")}  lanes ${avg("lanes")}  ` +
              `max/step ${avg("maxStep")}  bird:backing ${avg("ratio")}  ` +
              `downbeat ${(stats.reduce((a, s) => a + s.downbeat, 0) / stats.length * 100).toFixed(0)}%  ` +
              `leads ${avg("leads")}  birds w/ a part ${avg("parts")}`);
}

// Determinism: the same seed must rebuild the same song.
const a = ctx.generateSong(12345, "upbeat", pool);
const b = ctx.generateSong(12345, "upbeat", pool);
check(JSON.stringify(a) === JSON.stringify(b), "same seed produced different songs");
check(a.name === b.name, "same seed produced different names");

// The tempo override changes speed without reshuffling the arrangement.
const slow = ctx.generateSong(555, "upbeat", pool, { bpm: 90 });
const fast = ctx.generateSong(555, "upbeat", pool, { bpm: 170 });
check(slow.bpm === 90 && fast.bpm === 170, "tempo override not applied");
check(JSON.stringify(slow.lanes) === JSON.stringify(fast.lanes),
      "changing tempo changed which birds play");
check(JSON.stringify(slow.schedule) === JSON.stringify(fast.schedule),
      "changing tempo changed the arrangement");
check(slow.seconds > fast.seconds, "slower tempo did not produce a longer track");

// Pattern mode
const pat = {
  kind: "pattern", patternBars: 1, bars: 1, bpm: 128, root: 45,
  drums: { kick: new Array(16).fill(0), snare: new Array(16).fill(0),
           hat: new Array(16).fill(0), bass: new Array(16).fill(0) },
  lanes: [{ id: "x", bird: pool[0].key, clip: 0, semi: 3, cells: new Array(16).fill(0), pan: 0 }],
};
pat.drums.kick[0] = 1;
pat.lanes[0].cells[4] = 1;
const e0 = ctx.eventsFor(pat, 0);
const e4 = ctx.eventsFor(pat, 4);
const e20 = ctx.eventsFor(pat, 20);   // must wrap to step 4
check(e0.some((e) => e.type === "kick"), "pattern: kick missing at step 0");
check(e4.some((e) => e.type === "bird" && e.semitones === 3), "pattern: bird missing at step 4");
check(e20.some((e) => e.type === "bird"), "pattern: loop did not wrap");

console.log(fails ? `\n${fails} FAILURES` : "\nall checks passed");
process.exit(fails ? 1 : 0);
