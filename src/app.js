/* UI wiring for sound_bird_. BIRDS and AUDIO are injected by the build step. */

const BIRDS = window.BIRD_DATA || {};
const AUDIO = window.BIRD_AUDIO || {};
const PHOTOS = window.BIRD_PHOTOS || {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let currentSong = null;
let curMood = "upbeat";
let curPack = "all";
let curTempo = 130;          // what the speed slider is set to, in bpm
let loaded = false;
let loadPromise = null;

/* ---------------- loading ---------------- */
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function loadAll() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    Player.init();
    const jobs = [];
    for (const [key, sp] of Object.entries(BIRDS)) {
      sp.clips.forEach((c, i) => jobs.push([key, i, c.file]));
    }
    // Decoded in batches rather than one at a time: with well over a hundred
    // clips, sequential decoding is the slowest part of opening the page.
    let done = 0;
    const BATCH = 8;
    for (let start = 0; start < jobs.length; start += BATCH) {
      await Promise.all(jobs.slice(start, start + BATCH).map(async ([key, i, file]) => {
        const b64 = AUDIO[file];
        if (b64) {
          try {
            const buf = await Player.ctx.decodeAudioData(b64ToBuf(b64));
            if (!Player.buffers[key]) Player.buffers[key] = [];
            Player.buffers[key][i] = buf;
          } catch (e) {
            console.warn("could not decode", file, e);
          }
        }
        done++;
      }));
      const bar = $("#loadbar");
      if (bar) bar.style.width = (done / jobs.length) * 100 + "%";
    }
    // Drop any clip slots that failed so playback never hits a hole.
    for (const k of Object.keys(Player.buffers)) {
      Player.buffers[k] = Player.buffers[k].filter(Boolean);
      if (!Player.buffers[k].length) delete Player.buffers[k];
    }
    loaded = true;
  })();
  return loadPromise;
}

function playableBirds() {
  return Object.entries(BIRDS).filter(([k]) => Player.buffers[k] && Player.buffers[k].length);
}

function poolFor(pack) {
  return playableBirds()
    .filter(([, v]) => pack === "all" || v.pack === pack)
    .map(([k, v]) => ({ key: k, common: v.common, clipCount: Player.buffers[k].length }));
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- intro deck ---------------- */
const CARDS = [
  { t: "Hello speeper :)" },
  { t: "I made a creation for you." },
  { t: "Are you ready?" },
  { t: "3", count: true, auto: 850 },
  { t: "2", count: true, auto: 850 },
  { t: "1", count: true, auto: 850 },
  { tune: true },
  { t: "Did my acoust whittle like that? :)" },
  { t: "If you did, you are in for a hell of a treat." },
  { t: "I spent hours vibecoding this, so I hope you like it." },
  { t: "You can tinker around yourself and see what I made you - go wild, I hereby unleash this creation onto you!", enter: true },
];

let cardIdx = -1;
let cardBusy = false;

function showCard(i) {
  if (i >= CARDS.length) return enterApp();
  cardIdx = i;
  const c = CARDS[i];
  const card = $("#card");
  const text = $("#cardtext");
  const vis = $("#tunevis");
  const enter = $("#enterbtn");
  const hint = $("#hint");

  card.classList.remove("in");
  cardBusy = true;

  setTimeout(async () => {
    card.classList.toggle("count", !!c.count);
    text.textContent = c.t || "";
    text.classList.toggle("hide", !c.t);
    vis.classList.toggle("hide", !c.tune);
    enter.classList.toggle("hide", !c.enter);
    hint.classList.toggle("hide", !!c.enter || !!c.count || !!c.tune);
    card.classList.add("in");

    if (c.count) {
      setTimeout(() => { cardBusy = false; showCard(i + 1); }, c.auto);
      return;
    }
    if (c.tune) {
      await loadAll();
      await Player.resume();
      const ms = await playBirthday();
      animateVis(ms);
      setTimeout(() => { cardBusy = false; showCard(i + 1); }, ms + 900);
      return;
    }
    cardBusy = false;
  }, i === 0 ? 260 : 460);
}

function animateVis(ms) {
  const vis = $("#tunevis");
  vis.innerHTML = "";
  const bars = [];
  for (let i = 0; i < 22; i++) {
    const b = document.createElement("i");
    vis.appendChild(b);
    bars.push(b);
  }
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    if (t > ms + 400) { bars.forEach((b) => (b.style.height = "8px")); return; }
    bars.forEach((b, i) => {
      const v = Math.abs(Math.sin(t / 190 + i * 0.55)) * Math.abs(Math.cos(t / 640 + i * 0.2));
      b.style.height = 8 + v * 96 + "px";
    });
    requestAnimationFrame(frame);
  })(start);
}

function advance() {
  if (cardBusy) return;
  showCard(cardIdx + 1);
}

function enterApp() {
  $("#intro").classList.add("hide");
  $("#app").classList.remove("hide");
  buildAviary();
  buildSequencer();
  renderSaved();
  if (!currentSong) generate(false);
}

/* ---------------- generate view ---------------- */
/* play=false is used when the app first opens: a track is ready and waiting,
   but nothing makes noise until he asks it to. */
function generate(play = true) {
  const pool = poolFor(curPack);
  if (pool.length < 2) { toast("Not enough birds in that flock"); return; }
  currentSong = generateSong(null, curMood, pool, { bpm: curTempo });
  currentSong.pack = curPack;
  renderNow();
  renderLanes();
  if (play) startPlayback();
  else setPlayIcon(false);
}

/* Moving the speed slider keeps the arrangement and changes only the tempo,
   so it stays recognisably the same track. */
function retempo() {
  if (!currentSong) return;
  const wasPlaying = Player.playing && Player.mode === "song";
  const pack = currentSong.pack || curPack;
  const pool = poolFor(pack);
  if (pool.length < 2) return;
  currentSong = generateSong(currentSong.seed, currentSong.mood, pool, { bpm: curTempo });
  currentSong.pack = pack;
  renderNow();
  renderLanes();
  if (wasPlaying) startPlayback();
}

function setTempo(bpm, retrigger) {
  curTempo = Math.round(bpm);
  const slider = $("#temposlider");
  if (slider) slider.value = curTempo;
  const label = $("#tempolabel");
  if (label) label.textContent = curTempo + " bpm";
  if (retrigger) retempo();
}

function renderNow() {
  if (!currentSong) return;
  $("#trackname").textContent = currentSong.name;
  const mins = Math.round(currentSong.seconds);
  $("#trackmeta").textContent =
    `${currentSong.bpm} bpm  ·  ${currentSong.mood}  ·  ${mins}s  ·  ${currentSong.lanes.length} birds  ·  seed ${currentSong.seed}`;
  $("#savebtn").disabled = false;
  $("#dlbtn").disabled = false;
}

/* Which parts of the song a bird actually appears in, so the list says
   something useful now that roles move around between sections. */
function laneParts(song, lane) {
  const seen = [];
  (song.schedule || []).forEach((roles, i) => {
    const r = roles[lane.id];
    if (r) seen.push(r);
  });
  if (!seen.length) return "resting";
  const leads = seen.filter((r) => r === "lead").length;
  if (leads) return leads > 1 ? `leads ${leads} parts` : "leads a part";
  return seen.includes("answer") ? "answers" : "texture";
}

function renderLanes() {
  const box = $("#lanes");
  box.innerHTML = "";
  if (!currentSong) { box.innerHTML = '<div class="empty">No track loaded yet.</div>'; return; }
  currentSong.lanes.forEach((lane) => {
    const row = document.createElement("div");
    row.className = "lane";
    row.dataset.lane = lane.id;
    const sp = BIRDS[lane.bird] || {};
    row.innerHTML = `
      <span class="pip"></span>
      <div class="nm">${lane.common}<small>${sp.scientific || ""} · ${laneParts(currentSong, lane)}</small></div>
      <button class="tog solo" title="solo">S</button>
      <button class="tog mute" title="mute">M</button>`;
    row.querySelector(".solo").onclick = () => {
      lane.solo = !lane.solo;
      row.querySelector(".solo").classList.toggle("on", lane.solo);
      Player.applySolo();
      refreshLaneDim();
    };
    row.querySelector(".mute").onclick = () => {
      lane.muted = !lane.muted;
      row.querySelector(".mute").classList.toggle("on", lane.muted);
      Player.applySolo();
      refreshLaneDim();
    };
    box.appendChild(row);
  });
  refreshLaneDim();
}

function refreshLaneDim() {
  if (!currentSong) return;
  const anySolo = currentSong.lanes.some((l) => l.solo);
  currentSong.lanes.forEach((lane) => {
    const row = $(`.lane[data-lane="${lane.id}"]`);
    if (!row) return;
    const audible = anySolo ? lane.solo && !lane.muted : !lane.muted;
    row.classList.toggle("dim", !audible);
  });
}

function setPlayIcon(playing) {
  $("#playbtn").innerHTML = playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

async function startPlayback() {
  if (!currentSong) return;
  await Player.resume();
  Player.onStep = (step, total) => {
    $("#progress").style.width = Math.min(100, (step / total) * 100) + "%";
    const s = step % STEPS_PER_BAR;
    // A lane only lights up for the part it is playing in this section.
    const sec = sectionAt(currentSong, Math.floor(step / STEPS_PER_BAR));
    const roles = (currentSong.schedule || [])[currentSong.sections.indexOf(sec)] || {};
    currentSong.lanes.forEach((lane) => {
      const row = $(`.lane[data-lane="${lane.id}"]`);
      if (!row) return;
      const role = roles[lane.id];
      const hit = !!role && lane.patterns[role].some((h) => h.step === s);
      row.querySelector(".pip").classList.toggle("hit", hit);
      row.classList.toggle("resting", !role);
    });
  };
  Player.onEnd = () => {
    setPlayIcon(false);
    $("#progress").style.width = "100%";
    $$(".pip").forEach((p) => p.classList.remove("hit"));
  };
  Player.play(currentSong, "song");
  setPlayIcon(true);
  // Starting a track stops any sequencer loop, so its button must agree.
  $("#seqplay").textContent = "Play loop";
  $$("#seqtable .cell").forEach((c) => c.classList.remove("cur"));
}

/* ---------------- saving ---------------- */
const SAVE_KEY = "soundbird.saved.v1";
function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || []; } catch (e) { return []; }
}
function setSaved(list) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(list)); } catch (e) {}
}
function saveCurrent() {
  if (!currentSong) return;
  const list = getSaved();
  if (list.some((s) => s.seed === currentSong.seed && s.mood === currentSong.mood)) {
    toast("Already saved"); return;
  }
  list.unshift({ seed: currentSong.seed, mood: currentSong.mood,
                 pack: currentSong.pack || curPack,
                 name: currentSong.name, bpm: currentSong.bpm });
  setSaved(list.slice(0, 40));
  renderSaved();
  toast("Saved: " + currentSong.name);
}
function renderSaved() {
  const box = $("#savedlist");
  const list = getSaved();
  if (!list.length) { box.innerHTML = '<div class="empty">Nothing saved yet.</div>'; return; }
  box.innerHTML = "";
  list.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "saveitem";
    el.innerHTML = `<div class="nm">${s.name}</div>
      <div class="mt">${s.bpm} bpm · ${s.mood}</div>
      <button class="btn sm load">Load</button>
      <button class="btn sm del">Remove</button>`;
    el.querySelector(".load").onclick = () => {
      const pack = s.pack || "all";
      const pool = poolFor(pack);
      if (pool.length < 2) { toast("That flock is unavailable"); return; }
      currentSong = generateSong(s.seed, s.mood, pool, { bpm: s.bpm });
      currentSong.pack = pack;
      curMood = s.mood;
      $$("#moodseg button").forEach((b) => b.classList.toggle("on", b.dataset.mood === s.mood));
      setTempo(s.bpm, false);
      renderNow(); renderLanes(); startPlayback();
    };
    el.querySelector(".del").onclick = () => {
      const l = getSaved(); l.splice(i, 1); setSaved(l); renderSaved();
    };
    box.appendChild(el);
  });
}

/* ---------------- downloads ---------------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function safeName(s) {
  return s.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").toLowerCase();
}
async function downloadSong(song, label) {
  // Rendering a minute of audio takes a good few seconds, so the controls have
  // to say so rather than just going dead.
  const btns = [$("#dlbtn"), $("#seqdl")];
  const labels = btns.map((b) => (b ? b.textContent : null));
  btns.forEach((b) => { if (b) { b.disabled = true; b.textContent = "Rendering"; } });
  toast("Rendering the audio, this takes a few seconds");
  try {
    const blob = await Player.render(song);
    downloadBlob(blob, safeName(label) + ".wav");
    toast("Saved " + safeName(label) + ".wav");
  } catch (e) {
    console.error(e);
    toast("That one would not render, try again");
  }
  btns.forEach((b, i) => { if (b) { b.disabled = false; b.textContent = labels[i]; } });
}

/* ---------------- sequencer ---------------- */
let pattern = null;

function newPattern() {
  return {
    kind: "pattern", patternBars: 1, bars: 1, bpm: 128, swing: 0.08,
    root: 45, reverb: 0.24, delay: 0.26, seconds: 0,
    drums: { kick: new Array(16).fill(0), snare: new Array(16).fill(0),
             hat: new Array(16).fill(0), bass: new Array(16).fill(0) },
    lanes: [],
  };
}

function buildSequencer() {
  if (!pattern) {
    pattern = newPattern();
    pattern.drums.kick[0] = pattern.drums.kick[6] = pattern.drums.kick[10] = 1;
    pattern.drums.snare[4] = pattern.drums.snare[12] = 1;
    for (let i = 0; i < 16; i += 2) pattern.drums.hat[i] = 1;
    const pool = poolFor("all");
    for (let i = 0; i < Math.min(3, pool.length); i++) addLane(pool[i].key, false);
    if (pattern.lanes[0]) { pattern.lanes[0].cells[0] = 1; pattern.lanes[0].cells[8] = 1; }
    if (pattern.lanes[1]) { pattern.lanes[1].cells[6] = 1; pattern.lanes[1].cells[14] = 1; }
  }
  const sel = $("#addbird");
  sel.innerHTML = '<option value="">choose a bird</option>';
  playableBirds().forEach(([k, v]) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = v.common;
    sel.appendChild(o);
  });
  renderSeq();
}

function addLane(birdKey, redraw = true) {
  const sp = BIRDS[birdKey];
  if (!sp) return;
  const n = pattern.lanes.length;
  pattern.lanes.push({
    id: "p" + Date.now() + "_" + n,
    bird: birdKey, common: sp.common, clip: 0, semi: 0,
    cells: new Array(16).fill(0),
    pan: n % 2 === 0 ? -0.25 : 0.25,
    muted: false, solo: false, gain: 1,
  });
  if (redraw) renderSeq();
}

const DRUM_ROWS = [["kick", "Kick"], ["snare", "Snare"], ["hat", "Hat"], ["bass", "Bass"]];

function renderSeq() {
  const t = $("#seqtable");
  t.innerHTML = "";
  const head = document.createElement("tr");
  head.innerHTML = '<th class="lbl"></th>' +
    Array.from({ length: 16 }, (_, i) => `<th>${i % 4 === 0 ? i / 4 + 1 : ""}</th>`).join("");
  t.appendChild(head);

  DRUM_ROWS.forEach(([key, label]) => {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "lbl";
    td.innerHTML = `<div class="r"><span class="nm">${label}</span></div>`;
    tr.appendChild(td);
    for (let s = 0; s < 16; s++) {
      const cell = document.createElement("td");
      const b = document.createElement("button");
      b.className = "cell drum" + (s % 4 === 0 ? " beat" : "") + (pattern.drums[key][s] ? " on" : "");
      b.dataset.step = s;
      b.onclick = () => {
        pattern.drums[key][s] = pattern.drums[key][s] ? 0 : 1;
        b.classList.toggle("on", !!pattern.drums[key][s]);
        if (pattern.drums[key][s] && key !== "bass") previewDrum(key);
      };
      cell.appendChild(b);
      tr.appendChild(cell);
    }
    t.appendChild(tr);
  });

  pattern.lanes.forEach((lane) => {
    const tr = document.createElement("tr");
    tr.dataset.lane = lane.id;
    const td = document.createElement("td");
    td.className = "lbl";
    td.innerHTML = `<div class="r">
        <span class="nm" title="${lane.common}">${lane.common}</span>
        <select class="semi"></select>
        <button class="tog rm btn sm" title="remove" style="padding:2px 7px">x</button>
      </div>`;
    const sel = td.querySelector(".semi");
    for (let v = -12; v <= 14; v++) {
      const o = document.createElement("option");
      o.value = v; o.textContent = (v > 0 ? "+" : "") + v;
      if (v === lane.semi) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      lane.semi = parseInt(sel.value, 10);
      Player.preview(lane.bird, lane.clip, lane.semi);
    };
    td.querySelector(".rm").onclick = () => {
      pattern.lanes = pattern.lanes.filter((l) => l.id !== lane.id);
      renderSeq();
    };
    tr.appendChild(td);
    for (let s = 0; s < 16; s++) {
      const cell = document.createElement("td");
      const b = document.createElement("button");
      b.className = "cell" + (s % 4 === 0 ? " beat" : "") + (lane.cells[s] ? " on" : "");
      b.dataset.step = s;
      b.title = `${lane.common} · beat ${Math.floor(s / 4) + 1}.${(s % 4) + 1}`;
      b.onclick = () => {
        lane.cells[s] = lane.cells[s] ? 0 : 1;
        b.classList.toggle("on", !!lane.cells[s]);
        if (lane.cells[s]) Player.preview(lane.bird, lane.clip, lane.semi);
      };
      cell.appendChild(b);
      tr.appendChild(cell);
    }
    t.appendChild(tr);
  });
}

function previewDrum(kind) {
  Player.init(); Player.resume();
  if (!Player._pvGraph) Player._pvGraph = buildGraph(Player.ctx, { reverb: 0.2, delay: 0.1 });
  const t = Player.ctx.currentTime + 0.01;
  if (kind === "kick") kick(Player._pvGraph, t, 0.9);
  if (kind === "snare") snare(Player._pvGraph, t, 0.6);
  if (kind === "hat") hat(Player._pvGraph, t, 0.3);
}

async function toggleSeq() {
  if (Player.playing && Player.mode === "loop") {
    Player.stop();
    $("#seqplay").textContent = "Play loop";
    $$("#seqtable .cell").forEach((c) => c.classList.remove("cur"));
    return;
  }
  await Player.resume();
  Player.onStep = (step) => {
    const s = step % 16;
    $$("#seqtable .cell").forEach((c) => c.classList.toggle("cur", +c.dataset.step === s));
  };
  Player.onEnd = null;
  Player.play(pattern, "loop");
  $("#seqplay").textContent = "Stop";
  setPlayIcon(false);
  $("#progress").style.width = "0%";
  $$(".pip").forEach((p) => p.classList.remove("hit"));
}

function randomisePattern() {
  rnd.seed((Math.random() * 4294967295) >>> 0);
  pattern.drums.kick = euclid(3 + rnd.i(3), 16, rnd.i(4));
  pattern.drums.snare = new Array(16).fill(0);
  pattern.drums.snare[4] = pattern.drums.snare[12] = 1;
  pattern.drums.hat = euclid(rnd.chance(0.5) ? 8 : 11, 16, rnd.i(3));
  pattern.drums.bass = euclid(4 + rnd.i(3), 16, rnd.i(3));
  pattern.lanes.forEach((lane) => {
    lane.cells = euclid(2 + rnd.i(4), 16, rnd.i(8));
    lane.semi = rnd.pick([-5, -3, 0, 0, 2, 4, 7, 9, 12]);
  });
  renderSeq();
}

/* ---------------- aviary ---------------- */
function buildAviary(filter = "all") {
  const grid = $("#aviarygrid");
  grid.innerHTML = "";
  const all = playableBirds();
  const list = all.filter(([, v]) => filter === "all" || v.pack === filter);
  const counter = $("#aviarycount");
  if (counter) {
    const clips = list.reduce((a, [k]) => a + Player.buffers[k].length, 0);
    counter.textContent = filter === "all"
      ? `${all.length} birds, ${clips} sounds`
      : `${list.length} of ${all.length} birds`;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty">No birds in that flock.</div>'; return; }
  list.forEach(([key, sp]) => {
    const card = document.createElement("div");
    card.className = "bcard";
    const clips = Player.buffers[key] || [];
    const credits = sp.clips.slice(0, clips.length).map((c, i) => {
      const src = c.source
        ? `<a href="${c.source}" target="_blank" rel="noopener">${c.xc_id ? "XC" + c.xc_id : "listen"}</a>`
        : "";
      return `<span class="cline"><b>${i + 1}</b> ${c.recordist || "unknown"} · ${c.license || ""} · ${src}</span>`;
    }).join("");
    const photo = PHOTOS[key];
    const photoHtml = photo
      ? `<img class="photo" src="${photo.data}" alt="${sp.common}" loading="lazy" decoding="async">`
      : `<svg class="feather" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M50 12C34 14 20 26 16 42l-6 12 12-6c16-4 28-18 30-34z"/>
           <path d="M50 12L20 48"/>
         </svg>`;
    const photoCredit = photo
      ? `<span class="cline">Photo ${photo.photographer} · ${photo.license}${
           photo.source ? ` · <a href="${photo.source}" target="_blank" rel="noopener">Commons</a>` : ""}</span>`
      : "";
    card.innerHTML = `
      ${photoHtml}
      <div class="body">
        <span class="tag ${sp.pack}">${sp.pack}</span>
        <h3>${sp.common}</h3>
        <div class="sci">${sp.scientific}</div>
        <p class="blurb">${sp.blurb}</p>
        <div class="clips"></div>
        <div class="credit">Recorded by ${credits}${photoCredit}</div>
      </div>`;
    const cbox = card.querySelector(".clips");
    clips.forEach((_, i) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.textContent = "clip " + (i + 1);
      b.onclick = () => Player.preview(key, i, 0);
      cbox.appendChild(b);
    });
    const add = document.createElement("button");
    add.className = "btn sm gold";
    add.textContent = "to sequencer";
    add.onclick = () => {
      addLane(key);
      switchView("compose");
      toast(sp.common + " added");
    };
    cbox.appendChild(add);
    grid.appendChild(card);
  });
}

/* ---------------- views ---------------- */
function switchView(name) {
  $$("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  ["generate", "compose", "aviary"].forEach((v) => {
    $("#view-" + v).classList.toggle("hide", v !== name);
  });
}

/* ---------------- boot ---------------- */
function boot() {
  loadAll();

  $("#intro").addEventListener("click", (e) => {
    if (e.target.id === "enterbtn") return;
    advance();
  });
  document.addEventListener("keydown", (e) => {
    if ($("#intro").classList.contains("hide")) return;
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); advance(); }
  });
  $("#enterbtn").onclick = enterApp;
  const r0 = MOODS[curMood].bpm;
  setTempo((r0[0] + r0[1]) / 2, false);
  showCard(0);

  $$("nav.tabs button").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));

  $$("#moodseg button").forEach((b) => (b.onclick = () => {
    curMood = b.dataset.mood;
    $$("#moodseg button").forEach((x) => x.classList.toggle("on", x === b));
    // Each mood has its own natural pace, so the slider follows it.
    const r = MOODS[curMood].bpm;
    setTempo((r[0] + r[1]) / 2, false);
  }));
  $("#temposlider").oninput = (e) => setTempo(e.target.value, false);
  $("#temposlider").onchange = (e) => setTempo(e.target.value, true);
  $$("#packseg button").forEach((b) => (b.onclick = () => {
    curPack = b.dataset.pack;
    $$("#packseg button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $$("#aviaryfilter button").forEach((b) => (b.onclick = () => {
    $$("#aviaryfilter button").forEach((x) => x.classList.toggle("on", x === b));
    buildAviary(b.dataset.pack);
  }));

  // Wrapped so the click event is not passed through as the play argument.
  $("#genbtn").onclick = () => generate(true);
  $("#playbtn").onclick = () => {
    if (Player.playing && Player.mode === "song") { Player.stop(); setPlayIcon(false); }
    else startPlayback();
  };
  $("#savebtn").onclick = saveCurrent;
  $("#dlbtn").onclick = () => currentSong && downloadSong(currentSong, currentSong.name);

  $("#seqplay").onclick = toggleSeq;
  $("#seqclear").onclick = () => {
    pattern.lanes.forEach((l) => (l.cells = new Array(16).fill(0)));
    Object.keys(pattern.drums).forEach((k) => (pattern.drums[k] = new Array(16).fill(0)));
    renderSeq();
  };
  $("#seqrandom").onclick = randomisePattern;
  $("#seqdl").onclick = () => {
    const clone = JSON.parse(JSON.stringify(pattern));
    clone.bars = 4;                      // four times round the loop
    clone.seconds = (60 / clone.bpm) * 4 * clone.bars;
    downloadSong(clone, "sound-bird-loop");
  };
  $("#bpmslider").oninput = (e) => {
    pattern.bpm = parseInt(e.target.value, 10);
    $("#bpmlabel").textContent = pattern.bpm + " bpm";
  };
  $("#addbird").onchange = (e) => {
    if (e.target.value) { addLane(e.target.value); e.target.value = ""; }
  };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
