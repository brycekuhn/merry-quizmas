// The TV screen. It hosts the room, runs every round, collects answers and keeps score.
// Phones only send answers; everything they show comes from the "state" this page writes.
import {
  connect, ROUNDS, ROUND_ORDER, CHOICES, DURATION, NOSE_PREVIEW_MS, GAME_NAME,
  makeCode, esc, norm, hash, shuffle, lsGet, lsSet, plural, points, numText,
  randomPose, noseAt, deerSVG, noseSVG, fillLists,
} from "./game.js";

const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const stageEl = $("#stage"), topEl = $("#top"), statusEl = $("#status"), timerEl = $("#timer"), nextBtn = $("#next");
const HOST_KEY = "mq-host", SETTINGS_KEY = "mq-settings", USED_KEY = "mq-used";
const STAGES = { trivia: ["ask"], nose: ["ask"], closest: ["ask"], fake: ["write", "pick"], who: ["ask"], vote: ["ask"] };
const INPUT = new Set(["ask", "write", "pick"]);

let db, content, code, room;
let players = {}, scores = {}, about = {}, answers = {};
let state = { phase: "loading" };
let plan = null;
let settings = loadSettings();
let stopAnswers = null, stopRoom = [];
let endingKey = null, lastSecond = null, lastSig = "", noseHidden = false, answersReady = false;

// ---------- settings ----------

function loadSettings() {
  const saved = lsGet(SETTINGS_KEY) || {};
  const out = {};
  for (const k of ROUND_ORDER) {
    const s = saved[k] || {};
    out[k] = { on: s.on !== false, n: Math.max(1, Math.min(ROUNDS[k].max, s.n || ROUNDS[k].n)) };
  }
  return out;
}
function saveSettings() { lsSet(SETTINGS_KEY, settings); }
// The most questions a round can have: its own limit, or for Family trivia, how many family questions exist.
function roundMax(k) {
  if (ROUNDS[k].pool !== "family") return ROUNDS[k].max;
  return Math.max(1, ((content && content.trivia) || []).filter((x) => x.family).length);
}

// ---------- people ----------

function person(pid) {
  const p = players[pid];
  return p ? { name: p.name || "Someone", avatar: p.avatar || "❔" } : { name: "Someone", avatar: "❔" };
}
function tag(pid) { const p = person(pid); return `<span class="avatar">${esc(p.avatar)}</span> ${esc(p.name)}`; }
function faces(pids) { return `<span class="ppl">${pids.map((p) => `<span class="avatar" title="${esc(person(p).name)}">${esc(person(p).avatar)}</span>`).join("")}</span>`; }
function playerIds() { return Object.keys(players).sort((a, b) => (players[a].joined || 0) - (players[b].joined || 0)); }
function onlineIds() { return playerIds().filter((p) => players[p].online !== false); }

// ---------- sound (made in the browser, no files) ----------

const sfx = (() => {
  let ctx = null, muted = lsGet("mq-mute") === true;
  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type = "sine", gain = 0.12) {
    const c = ac();
    if (!c || muted) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + start;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  const bell = (f, s, d = 0.9, g = 0.1) => { tone(f, s, d, "sine", g); tone(f * 2.76, s, d * 0.45, "sine", g * 0.3); tone(f * 5.4, s, d * 0.25, "sine", g * 0.15); };
  return {
    unlock: ac,
    get muted() { return muted; },
    toggle() { muted = !muted; lsSet("mq-mute", muted); },
    join() { bell(1318.5, 0, 0.5, 0.08); bell(1760, 0.09, 0.6, 0.08); },
    tick(last) { tone(last ? 1320 : 990, 0, 0.07, "square", 0.025); },
    go() { bell(784, 0, 0.5); bell(1046.5, 0.12, 0.8); },
    reveal() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, i * 0.08, 1.1, 0.08)); },
    jingle() {
      const E = 659.25, G = 783.99, C = 523.25, D = 587.33, b = 0.17;
      [[E, 0], [E, 1], [E, 2], [E, 4], [E, 5], [E, 6], [E, 8], [G, 9], [C, 10], [D, 11], [E, 12]].forEach(([f, t]) => bell(f, t * b, 0.6, 0.09));
    },
    fanfare() { [[523.25, 0], [659.25, 0.15], [783.99, 0.3], [1046.5, 0.45], [783.99, 0.75], [1046.5, 0.9]].forEach(([f, t]) => bell(f, t, 1, 0.1)); },
  };
})();

// ---------- family photos ----------
// The photos are published encrypted (see encrypt-photos.mjs). The TV unlocks them with the family
// password, remembers the password, and shows them as blob URLs. Phones never load them.

const photos = (() => {
  const PASS_KEY = "mq-photo-pass";
  let manifest = null, key = null;
  const urls = {}, loading = {};
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const open = (k, bytes) => crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12));
  async function tryPass(pass) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pass).trim().normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
    const k = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(manifest.salt), iterations: manifest.iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    try { await open(k, b64(manifest.check)); } catch { return false; }
    key = k;
    lsSet(PASS_KEY, String(pass).trim());
    manifest.files.forEach(want);
    return true;
  }
  function want(name) {
    if (!key || urls[name] || loading[name] || !manifest.files.includes(name)) return;
    const type = /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg";
    loading[name] = fetch(`photos/${name}.enc`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((buf) => open(key, new Uint8Array(buf)))
      .then((plain) => { urls[name] = URL.createObjectURL(new Blob([plain], { type })); renderStage(); })
      .catch(() => { delete loading[name]; });
  }
  return {
    get exists() { return !!manifest; },
    get unlocked() { return !!key; },
    get count() { return manifest ? manifest.files.length : 0; },
    url: (name) => urls[name],
    want,
    async init() {
      if (!window.crypto || !crypto.subtle) return; // needs https or localhost
      try { const r = await fetch("photos/manifest.json", { cache: "no-store" }); if (r.ok) manifest = await r.json(); } catch { /* no photos */ }
      const saved = lsGet(PASS_KEY);
      if (manifest && saved && !(await tryPass(saved))) lsSet(PASS_KEY, null);
    },
    unlock: (pass) => (manifest ? tryPass(pass) : Promise.resolve(false)),
  };
})();

function photosHTML(names) {
  if (!names || !names.length) return "";
  return `<div class="photos${names.length > 1 ? " two" : ""}">${names.map((n) => {
    const url = photos.url(n);
    if (url) return `<img src="${url}" alt="Family photo">`;
    photos.want(n);
    return `<div class="ph" role="img" aria-label="${photos.unlocked ? "Loading photo" : "Photo locked"}">${photos.unlocked ? "📷" : "🔒"}</div>`;
  }).join("")}</div>`;
}

// ---------- snow ----------

function startSnow() {
  const cv = $("#snow"), cx = cv.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0, h = 0, dpr = 1;
  const flakes = [];
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = cv.width = innerWidth * dpr; h = cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
  }
  size();
  addEventListener("resize", size);
  for (let i = 0; i < 90; i++) flakes.push({ x: Math.random() * w, y: Math.random() * h, r: 0.6 + Math.random() * 2.2, s: 0.25 + Math.random() * 0.7, d: Math.random() * 6.28 });
  function frame(t) {
    cx.clearRect(0, 0, w, h);
    cx.fillStyle = "rgba(255,255,255,0.5)";
    for (const f of flakes) {
      if (!still) { f.y += f.s * dpr; f.x += Math.sin(t / 2200 + f.d) * 0.3 * dpr; }
      if (f.y > h + 6) { f.y = -6; f.x = Math.random() * w; }
      cx.beginPath(); cx.arc(f.x, f.y, f.r * dpr, 0, 6.283); cx.fill();
    }
    if (!still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- room lifecycle ----------

async function boot() {
  startSnow();
  showMessage("Getting the sleigh ready…", "");
  try {
    const [backend, c] = await Promise.all([
      connect({ practice: params.has("practice") }),
      fetch("content.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("Couldn’t load content.json."); return r.json(); }),
    ]);
    db = backend; content = c;
    await photos.init();
  } catch (e) {
    showMessage("Something went wrong", esc(e.message || e), `<button class="btn primary" data-act="reload">Try again</button>`);
    return;
  }
  const saved = lsGet(HOST_KEY);
  if (saved && saved.mode === db.mode && saved.code) {
    const st = await db.get(`rooms/${saved.code}/state`);
    if (st && st.phase === "lobby") return openRoom(saved.code, st, null);
    if (st && st.phase !== "final" && saved.plan) {
      showMessage("Pick up where you left off?",
        `There’s a game in progress with code <b>${esc(saved.code)}</b>${st.round ? ` (round ${st.round.num} of ${st.round.of}: ${esc(st.round.name)})` : ""}.`,
        `<button class="btn primary" data-act="resume">Resume the game</button><button class="btn" data-act="fresh">Start a new game</button>`);
      resumeOffer = { saved, st };
      return;
    }
  }
  await createRoom();
}
let resumeOffer = null;

async function createRoom() {
  let c = makeCode();
  for (let i = 0; i < 8; i++) { if (!(await db.get(`rooms/${c}/meta`))) break; c = makeCode(); }
  const st = { phase: "lobby", seq: 1 };
  await db.set(`rooms/${c}`, { meta: { created: db.now(), v: 1 }, state: st });
  openRoom(c, st, null);
}

function openRoom(c, st, savedPlan) {
  stopRoom.forEach((f) => f && f());
  code = c; room = `rooms/${c}`;
  state = st || { phase: "lobby", seq: 1 };
  plan = savedPlan;
  let known = null;
  stopRoom = [
    db.on(room + "/players", (v) => {
      // A removed phone that reconnects can leave a nameless stub behind; ignore those.
      players = Object.fromEntries(Object.entries(v || {}).filter(([, p]) => p && p.name));
      const n = Object.keys(players).length;
      if (known !== null && n > known && state.phase === "lobby") sfx.join();
      known = n;
      renderStage(); renderStatus(); renderNext();
      checkEveryone();
    }),
    db.on(room + "/scores", (v) => { scores = v || {}; }),
    db.on(room + "/about", (v) => { about = v || {}; if (state.phase === "lobby") renderStage(); }),
  ];
  if (INPUT.has(state.phase) && state.key) listenAnswers(state.key);
  persist();
  render();
}

function persist() { lsSet(HOST_KEY, { mode: db.mode, code, plan }); }

function setState(next) {
  state = { ...next, seq: (state.seq || 0) + 1 };
  db.set(room + "/state", state);
  persist();
  render();
}

function listenAnswers(key) {
  if (stopAnswers) stopAnswers();
  answers = {};
  answersReady = false;
  stopAnswers = db.on(`${room}/answers/${key}`, (v) => {
    if (state.key !== key) return;
    answers = v || {};
    answersReady = true;
    renderStatus();
    checkEveryone();
  });
}

function checkEveryone() {
  if (!INPUT.has(state.phase)) return;
  const want = onlineIds();
  if (want.length && want.every((p) => answers[p] != null)) endSoon();
}
function endSoon() {
  if (endingKey === state.key) return;
  const key = (endingKey = state.key);
  setTimeout(() => { if (state.key === key && INPUT.has(state.phase)) endStage(); }, 900);
}

// ---------- building a game ----------

function buildPlan() {
  const used = new Set(lsGet(USED_KEY) || []);
  const thisGame = new Set();
  function take(list, n, idOf) {
    const fresh = shuffle(list.filter((x) => !used.has(idOf(x))));
    const stale = shuffle(list.filter((x) => used.has(idOf(x)) && !thisGame.has(idOf(x))));
    const out = fresh.concat(stale).slice(0, n);
    out.forEach((x) => { used.add(idOf(x)); thisGame.add(idOf(x)); });
    return out;
  }
  const ids = playerIds();
  const rounds = [], skipped = [];
  // Family questions ("family": true) only appear in the Family trivia round; the other trivia rounds use the rest.
  const triviaPool = content.trivia || [];
  const family = triviaPool.filter((x) => x.family), general = triviaPool.filter((x) => !x.family);
  const triviaId = (x) => "t" + hash(x.q);
  for (const key of ROUND_ORDER) {
    const cfg = settings[key], meta = ROUNDS[key];
    if (!cfg.on) continue;
    let items = [];
    if (meta.kind === "trivia") {
      items = take(meta.pool === "family" ? family : general, cfg.n, triviaId).map((x) => {
        const order = shuffle([0, 1, 2, 3].slice(0, x.a.length));
        return { q: x.q, options: order.map((i) => x.a[i]), answer: order.indexOf(0), fact: x.fact || "",
          photos: x.photos || [], showPhotos: x.showPhotos === "question" ? "question" : "reveal" };
      });
      if (!items.length && meta.pool === "family") { skipped.push(meta.name + " (no family questions in content.json)"); continue; }
    } else if (meta.kind === "nose") {
      for (let i = 0; i < cfg.n; i++) items.push({ pose: randomPose() });
    } else if (meta.kind === "closest") {
      items = take(content.closest || [], cfg.n, (x) => "c" + hash(x.q)).map((x) => ({ ...x }));
    } else if (meta.kind === "fake") {
      items = take(content.fake || [], cfg.n, (x) => "f" + hash(x.q)).map((x) => ({ ...x }));
    } else if (meta.kind === "who") {
      items = whoItems(cfg.n);
      if (!items.length) { skipped.push(meta.name + " (needs answers from at least 2 players)"); continue; }
    } else if (meta.kind === "vote") {
      if (ids.length < 3) { skipped.push(meta.name + " (needs at least 3 players)"); continue; }
      items = take(content.superlatives || [], cfg.n, (x) => "v" + hash(x)).map((x) => ({ prompt: x }));
    }
    if (items.length) rounds.push({ key, items });
  }
  lsSet(USED_KEY, [...used].slice(-600));
  return { rounds, r: 0, i: 0, s: 0, delta: {}, skipped };
}

function whoItems(n) {
  const byAuthor = [];
  for (const pid of shuffle(Object.keys(about))) {
    if (!players[pid]) continue;
    const list = Object.values(about[pid] || {}).filter((e) => e && e.p && e.a && String(e.a).trim());
    if (list.length) byAuthor.push(shuffle(list).map((e) => ({ author: pid, prompt: e.p, answer: String(e.a).trim().slice(0, 80) })));
  }
  if (byAuthor.length < 2) return [];
  const out = [];
  while (out.length < n && byAuthor.some((l) => l.length)) for (const l of byAuthor) if (l.length && out.length < n) out.push(l.shift());
  return out;
}

// ---------- flow ----------

function roundInfo() {
  const rd = plan.rounds[plan.r], meta = ROUNDS[rd.key];
  return {
    kind: meta.kind,
    round: { key: rd.key, name: meta.name, icon: meta.icon, how: meta.how, num: plan.r + 1, of: plan.rounds.length, mult: meta.mult || 1 },
    qOf: rd.items.length,
  };
}
function current() { const rd = plan.rounds[plan.r]; return { rd, item: rd.items[plan.i], kind: ROUNDS[rd.key].kind, mult: ROUNDS[rd.key].mult || 1 }; }

async function startGame() {
  if (!Object.keys(players).length) return;
  sfx.unlock();
  plan = buildPlan();
  if (!plan.rounds.length) { alert("Turn on at least one round first."); plan = null; return; }
  await db.remove(room + "/answers");
  await db.remove(room + "/scores");
  scores = {};
  sfx.jingle();
  goIntro();
}

function goIntro() {
  plan.i = 0; plan.s = 0; plan.delta = {};
  setState({ phase: "intro", ...roundInfo(), skipped: plan.r === 0 ? plan.skipped : [] });
}

function startStage() {
  const { item, kind } = current();
  const stageName = STAGES[kind][plan.s];
  const key = `r${plan.r}i${plan.i}s${plan.s}`;
  const secs = kind === "fake" ? (stageName === "write" ? DURATION.write : DURATION.fakevote) : DURATION[kind];
  const now = db.now();
  endingKey = null; lastSecond = null; noseHidden = false;
  listenAnswers(key);
  setState({ phase: stageName, ...roundInfo(), qNum: plan.i + 1, key, q: payload(kind, item, stageName), startedAt: now, deadline: now + secs * 1000 });
  sfx.go();
}

function payload(kind, item, stageName) {
  switch (kind) {
    case "trivia": return { text: item.q, options: item.options, photos: item.showPhotos === "question" ? item.photos || [] : [] };
    case "nose": return { pose: item.pose };
    case "closest": return { text: item.q, unit: item.unit || "" };
    case "fake":
      if (stageName === "write") return { text: item.q, truth: [item.answer].concat(item.accept || []).map((a) => hash(norm(a))) };
      return { text: item.q, options: item.options.map((o) => ({ id: o.id, text: o.text })), writeKey: `r${plan.r}i${plan.i}s0` };
    case "who": return { prompt: item.prompt, answer: item.answer, choices: playerIds() };
    case "vote": return { text: item.prompt, choices: playerIds() };
  }
  return {};
}

function endStage() {
  if (!INPUT.has(state.phase) || !plan) return;
  const { item, kind } = current();
  item.got = item.got || {};
  item.got[plan.s] = answers;
  item.span = { start: state.startedAt, end: state.deadline };
  if (plan.s + 1 < STAGES[kind].length) {
    if (kind === "fake") buildFakeOptions(item);
    plan.s++;
    startStage();
    return;
  }
  doReveal();
}

function buildFakeOptions(item) {
  const truths = new Set([item.answer].concat(item.accept || []).map(norm));
  const groups = new Map();
  for (const [pid, a] of Object.entries(item.got[0] || {})) {
    const text = String((a && a.v) || "").trim().slice(0, 40);
    const k = norm(text);
    if (!k || truths.has(k)) continue;
    if (!groups.has(k)) groups.set(k, { text, authors: [] });
    groups.get(k).authors.push(pid);
  }
  const opts = [...groups.values()];
  for (const d of shuffle(item.decoys || [])) {
    if (opts.length >= 3) break;
    const k = norm(d);
    if (!groups.has(k) && !truths.has(k)) opts.push({ text: d, authors: [], house: true });
  }
  opts.push({ text: item.answer, authors: [], truth: true });
  item.options = shuffle(opts).map((o, i) => ({ id: "o" + i, ...o }));
}

function doReveal() {
  const { item, kind, mult } = current();
  const pts = {};
  const add = (pid, n) => { if (n > 0 && players[pid]) pts[pid] = (pts[pid] || 0) + n; };
  let reveal = {};
  const got = item.got[0] || {};

  if (kind === "trivia") {
    const counts = item.options.map(() => 0), right = [];
    const span = Math.max(1, item.span.end - item.span.start);
    for (const [pid, a] of Object.entries(got)) {
      const v = a && a.v;
      if (typeof v !== "number" || v < 0 || v >= counts.length) continue;
      counts[v]++;
      if (v === item.answer) {
        right.push(pid);
        add(pid, Math.round(500 + 500 * Math.max(0, Math.min(1, (item.span.end - a.t) / span))));
      }
    }
    reveal = { text: item.q, options: item.options, answer: item.answer, counts, right, fact: item.fact, photos: item.photos || [] };
  } else if (kind === "nose") {
    const target = noseAt(item.pose), pins = [];
    for (const [pid, a] of Object.entries(got)) {
      const v = a && a.v;
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      const x = Math.max(0, Math.min(1, v.x)), y = Math.max(0, Math.min(1, v.y));
      const d = Math.hypot(x - target.x, y - target.y);
      pins.push({ pid, x, y, d, pts: Math.round(1000 * Math.max(0, 1 - d / 0.4)) });
    }
    pins.sort((a, b) => a.d - b.d);
    if (pins.length && pins[0].pts > 0) pins.filter((p) => p.d === pins[0].d).forEach((p) => { p.best = true; p.pts += 250; });
    pins.forEach((p) => add(p.pid, p.pts));
    reveal = { pose: item.pose, target, pins };
  } else if (kind === "closest") {
    const list = [];
    for (const [pid, a] of Object.entries(got)) {
      const v = Number(a && a.v);
      if (Number.isFinite(v)) list.push({ pid, v, diff: Math.abs(v - item.answer) });
    }
    list.sort((a, b) => a.diff - b.diff);
    list.forEach((g) => {
      g.rank = 1 + list.filter((o) => o.diff < g.diff).length;
      g.pts = ({ 1: 1000, 2: 600, 3: 400 })[g.rank] || 100;
      if (g.diff === 0) g.pts += 500;
      add(g.pid, g.pts);
    });
    reveal = { text: item.q, answer: item.answer, unit: item.unit || "", guesses: list, fact: item.fact || "" };
  } else if (kind === "fake") {
    const votes = item.got[1] || {};
    const options = item.options.map((o) => ({ ...o, voters: [] }));
    for (const [pid, a] of Object.entries(votes)) {
      const o = options.find((x) => x.id === (a && a.v));
      if (!o) continue;
      o.voters.push(pid);
      if (o.truth) add(pid, 1000);
      else if (!o.authors.includes(pid)) o.authors.forEach((au) => add(au, 500));
    }
    reveal = { text: item.q, answer: item.answer, options, fact: item.fact || "" };
  } else if (kind === "who") {
    const right = [], wrong = [];
    for (const [pid, a] of Object.entries(got)) {
      if (pid === item.author || !a || !a.v || a.mine) continue;
      if (a.v === item.author) { right.push(pid); add(pid, 700); } else wrong.push(pid);
    }
    add(item.author, 200 * wrong.length);
    reveal = { prompt: item.prompt, answer: item.answer, author: item.author, right, fooled: wrong.length };
  } else if (kind === "vote") {
    const counts = {}, votes = {};
    for (const [pid, a] of Object.entries(got)) {
      if (!a || !a.v || !players[a.v]) continue;
      votes[pid] = a.v;
      counts[a.v] = (counts[a.v] || 0) + 1;
    }
    const top = Math.max(0, ...Object.values(counts));
    const winners = top ? Object.keys(counts).filter((p) => counts[p] === top) : [];
    for (const [pid, t] of Object.entries(votes)) if (winners.includes(t)) add(pid, 300);
    reveal = { text: item.prompt, counts, winners };
  }

  const update = {};
  for (const pid of Object.keys(pts)) {
    pts[pid] *= mult;
    scores[pid] = (scores[pid] || 0) + pts[pid];
    plan.delta[pid] = (plan.delta[pid] || 0) + pts[pid];
    update[pid] = scores[pid];
  }
  if (Object.keys(update).length) db.update(room + "/scores", update);
  reveal.pts = pts;
  const { startedAt, deadline, ...rest } = state;
  setState({ ...rest, phase: "reveal", reveal });
  sfx.reveal();
}

function board() {
  const ids = new Set(playerIds().concat(Object.keys(scores)));
  return [...ids].filter((p) => players[p])
    .map((pid) => ({ pid, score: scores[pid] || 0, delta: (plan && plan.delta[pid]) || 0 }))
    .sort((a, b) => b.score - a.score || person(a.pid).name.localeCompare(person(b.pid).name));
}

function next() {
  sfx.unlock();
  const ph = state.phase;
  if (ph === "lobby") return startGame();
  if (ph === "intro") return startStage();
  if (INPUT.has(ph)) { endingKey = state.key; return endStage(); }
  if (ph === "reveal") {
    if (plan.i + 1 < plan.rounds[plan.r].items.length) { plan.i++; plan.s = 0; return startStage(); }
    if (plan.r + 1 >= plan.rounds.length) { setState({ phase: "final", board: board() }); sfx.fanfare(); return; }
    setState({ phase: "scores", ...roundInfo(), board: board() });
    return;
  }
  if (ph === "scores") { plan.r++; return goIntro(); }
  if (ph === "final") return backToLobby();
}

async function backToLobby() {
  plan = null;
  if (stopAnswers) stopAnswers();
  await db.remove(room + "/answers");
  setState({ phase: "lobby" });
}

// ---------- rendering ----------

function render() { renderTop(); renderStage(); renderStatus(); renderNext(); }

function showMessage(title, body, actions = "") {
  topEl.innerHTML = `<span class="logo">${GAME_NAME}</span>`;
  stageEl.innerHTML = `<div class="message"><h1>${esc(title)}</h1>${body ? `<p>${body}</p>` : ""}${actions ? `<div class="row">${actions}</div>` : ""}</div>`;
  nextBtn.hidden = true;
  statusEl.innerHTML = "";
}

function renderTop() {
  const inGame = state.phase !== "lobby" && state.phase !== "loading";
  let where = "";
  if (state.round && state.phase !== "final") {
    where = `<strong>${esc(state.round.icon)} ${esc(state.round.name)}</strong>`;
    if (state.qNum) where += ` · ${state.qNum} of ${state.qOf}`;
    else where += ` · round ${state.round.num} of ${state.round.of}`;
  }
  topEl.innerHTML = `<span class="logo">${inGame ? GAME_NAME : ""}</span><span class="where">${where}</span>` +
    (inGame ? `<span class="room">Join code <b>${esc(code)}</b></span>` : "") +
    `<span class="tools">${inGame && state.phase !== "final" ? `<button class="btn small quiet" data-act="lobby" title="End this game and go back to the lobby">End game</button>` : ""}` +
    `<button class="btn small quiet" data-act="mute" aria-pressed="${!sfx.muted}" title="Sound">${sfx.muted ? "🔇 Sound off" : "🔊 Sound on"}</button></span>`;
}

function renderNext() {
  const ph = state.phase;
  let label = "", disabled = false;
  if (ph === "lobby") { label = "Start the game"; disabled = !Object.keys(players).length; }
  else if (ph === "intro") label = "Start the round";
  else if (INPUT.has(ph)) label = "Skip the timer";
  else if (ph === "reveal") {
    const last = plan && plan.i + 1 >= plan.rounds[plan.r].items.length;
    label = !last ? "Next question" : plan.r + 1 >= plan.rounds.length ? "Final results" : "See the scores";
  } else if (ph === "scores") label = "Next round";
  else if (ph === "final") label = "Back to the lobby";
  nextBtn.hidden = !label;
  nextBtn.textContent = label;
  nextBtn.disabled = disabled;
  nextBtn.classList.toggle("quiet", INPUT.has(ph));
  nextBtn.classList.toggle("primary", !INPUT.has(ph));
}

function renderStatus() {
  const ph = state.phase;
  if (INPUT.has(ph)) {
    const ids = onlineIds();
    const n = ids.filter((p) => answers[p] != null).length;
    statusEl.innerHTML = `<ul class="answered" aria-hidden="true">${ids.map((p) => `<li class="${answers[p] != null ? "in" : ""}" title="${esc(person(p).name)}">${esc(person(p).avatar)}</li>`).join("")}</ul>` +
      `<span class="answered-n">${n} of ${ids.length} ${ph === "write" ? "written" : ph === "pick" ? "voted" : "answered"}</span>`;
  } else if (ph === "lobby") {
    statusEl.innerHTML = db && db.mode === "practice" ? `<span class="answered-n">Practice mode</span>` : "";
  } else statusEl.innerHTML = "";
}

function renderStage() {
  // Before a room is open the stage holds a message (loading, an error, "pick up where you left off?"),
  // and late events such as a photo finishing its decryption must not wipe it.
  if (!db || state.phase === "loading") return;
  // Animate only when the screen moves on, not when it redraws in place (a player joining, a setting changing).
  const sig = state.seq + ":" + state.phase + ":" + (noseHidden ? 1 : 0);
  const moved = sig !== lastSig;
  stageEl.classList.remove("enter");
  stageEl.innerHTML = stageHTML();
  if (moved) {
    lastSig = sig;
    void stageEl.offsetWidth;
    stageEl.classList.add("enter");
  }
}

function stageHTML() {
  const ph = state.phase, k = state.kind, q = state.q || {};
  if (ph === "lobby") return lobbyHTML();
  if (ph === "intro") return introHTML();
  if (ph === "scores") return scoresHTML();
  if (ph === "final") return finalHTML();
  if (ph === "reveal") return revealHTML();
  if (k === "trivia") return `<h1 class="q">${esc(q.text)}</h1>${withPhotos(q.photos, tilesHTML(q.options))}`;
  if (k === "nose") return noseAskHTML();
  if (k === "closest") return `<h1 class="q huge">${esc(q.text)}</h1><p class="under muted">Type your guess${q.unit ? ` (in ${esc(q.unit)})` : ""} on your phone.</p>`;
  if (k === "fake" && ph === "write") return `<h1 class="q huge">${blanks(q.text)}</h1><p class="under muted">Write a believable fake answer on your phone. If you know the real one, keep it to yourself!</p>`;
  if (k === "fake" && ph === "pick") return `<h1 class="q">${blanks(q.text)}</h1><div class="opts">${q.options.map((o) => `<div class="opt"><span class="tx">${esc(o.text)}</span></div>`).join("")}</div><p class="under muted">Which one is real? Vote on your phone.</p>`;
  if (k === "who") return `<p class="prompt">${esc(q.prompt)}</p><p class="quote">${esc(q.answer)}</p><p class="under muted">Who wrote this? Guess on your phone.</p>`;
  if (k === "vote") return `<p class="prompt">Everyone vote!</p><h1 class="q huge">${esc(q.text)}</h1><p class="under muted">Vote on your phone. You can’t vote for yourself.</p>`;
  return "";
}

function withPhotos(names, inner) {
  return names && names.length ? `<div class="photoq">${photosHTML(names)}${inner}</div>` : inner;
}
function blanks(text) { return esc(text).replace(/_{2,}/g, '<span class="blank"></span>'); }

function tilesHTML(options, rv) {
  const total = rv ? Math.max(1, rv.counts.reduce((a, b) => a + b, 0)) : 1;
  return `<div class="tiles${rv ? " revealed" : ""}">${options.map((o, i) => {
    const c = CHOICES[i], right = rv && i === rv.answer;
    return `<div class="tile ${c.cls}${right ? " right" : ""}"><span class="ic">${c.icon}</span><span class="tx">${esc(o)}</span>` +
      (rv ? `${right ? `<span class="tick" aria-label="Correct">✓</span>` : ""}<span class="ct" aria-label="${plural(rv.counts[i], "answer")}">${rv.counts[i]}</span><span class="bar"><i style="width:${(rv.counts[i] / total) * 100}%"></i></span>` : "") +
      `</div>`;
  }).join("")}</div>`;
}

function lobbyHTML() {
  const joinBase = new URL("./", location.href);
  const url = joinBase.href + "?room=" + code;
  const shortUrl = (joinBase.host + joinBase.pathname).replace(/\/$/, "");
  const ids = playerIds();
  const practice = db.mode === "practice";
  const list = ids.length
    ? ids.map((p) => {
      const pl = players[p], done = !!about[p];
      return `<li class="${pl.online === false ? "off" : ""}"><span class="avatar">${esc(pl.avatar)}</span><span class="nm">${esc(pl.name)}</span><span class="st">${done ? "Ready ✓" : "Answering questions ✍️"}</span><button class="x" data-act="kick" data-pid="${esc(p)}" aria-label="Remove ${esc(pl.name)}">✕</button></li>`;
    }).join("")
    : `<li class="empty" style="grid-column:1/-1;background:none;border:0">Waiting for the first elf to join…</li>`;
  const rounds = ROUND_ORDER.map((k) => {
    const r = ROUNDS[k], s = settings[k], top = roundMax(k), n = Math.min(s.n, top);
    return `<li class="${s.on ? "" : "off"}"><button class="tg" data-act="toggle" data-k="${k}" aria-pressed="${s.on}" aria-label="${esc(r.name)}">${s.on ? "✓" : ""}</button>` +
      `<span class="rn">${r.icon} ${esc(r.name)}</span><span class="stepper"><button data-act="dec" data-k="${k}" aria-label="Fewer questions" ${n <= 1 ? "disabled" : ""}>−</button><span>${n}</span>` +
      `<button data-act="inc" data-k="${k}" aria-label="More questions" ${n >= top ? "disabled" : ""}>+</button></span></li>`;
  }).join("");
  const notes = [];
  const authors = Object.keys(about).filter((p) => players[p] && Object.values(about[p] || {}).some((e) => e && e.a));
  if (settings.who.on && ids.length && authors.length < 2) notes.push("“Who said that?” needs at least 2 players to answer the joining questions.");
  if (settings.vote.on && ids.length && ids.length < 3) notes.push("“Most likely to…” needs at least 3 players.");
  return `<div class="lobby">
    <section class="join card">
      <h1 class="logo">${GAME_NAME}</h1>
      <ol class="steps"><li>On your phone, scan the code or go to <strong>${esc(shortUrl)}</strong></li><li>Then enter this code:</li></ol>
      <div class="bigcode" aria-label="Room code ${code.split("").join(" ")}">${esc(code)}</div>
      ${practice ? `<p class="practice">Practice mode: phones can’t join yet. Open phone tabs in this browser to try it out.<br><button class="btn small" data-act="phone" style="margin-top:.5em">Open a phone tab</button></p>` : qrSVG(url)}
    </section>
    <section class="crowd">
      <h2>Players <span class="muted">${ids.length}</span></h2>
      <ul class="players">${list}</ul>
      <div class="rounds card"><h3>Rounds and questions</h3><ul>${rounds}</ul>${notes.map((n) => `<p class="warn">${esc(n)}</p>`).join("")}${photoNote()}</div>
    </section>
  </div>`;
}

function photoNote() {
  if (!photos.exists) return "";
  if (photos.unlocked) return `<p class="photo-note">📷 ${plural(photos.count, "family photo")} unlocked on this screen</p>`;
  return `<p class="photo-note">🔒 ${plural(photos.count, "family photo")} locked <button class="btn small" data-act="unlock">Unlock</button></p>`;
}

function qrSVG(text) {
  if (typeof window.qrcode !== "function") return `<p class="muted">Loading the QR code…</p>`;
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg class="qr" viewBox="-4 -4 ${n + 8} ${n + 8}" role="img" aria-label="QR code for the join page" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${n + 8}" height="${n + 8}" fill="#fff"/><path d="${d}" fill="#0B1B2E"/></svg>`;
}

function introHTML() {
  const r = state.round;
  const skipped = (state.skipped || []).length ? `<p class="muted" style="font-size:.9em">Skipping: ${esc(state.skipped.join("; "))}</p>` : "";
  return `<div class="intro"><div class="big-icon">${r.icon}</div><p class="kicker">Round ${r.num} of ${r.of}</p><h1>${esc(r.name)}</h1>` +
    (r.mult > 1 ? `<span class="badge">Double points</span>` : "") + `<p>${esc(r.how)}</p>${skipped}</div>`;
}

function noseAskHTML() {
  const q = state.q, left = state.startedAt + NOSE_PREVIEW_MS - db.now();
  const showing = left > 0 && !noseHidden;
  const box = `<div class="deerbox"><svg viewBox="0 0 100 100" aria-hidden="true">${showing ? deerSVG(q.pose) : ""}</svg>` +
    (showing ? `<span class="count" id="nosecount">${Math.ceil(left / 1000)}</span>` : `<div class="veil"><div><span class="ic">🙈</span>Blindfolds on!</div></div>`) + `</div>`;
  return `<div class="split">${box}<div class="side"><h2>${showing ? "Remember where his nose goes…" : "Tap where the nose goes!"}</h2>` +
    `<p>${showing ? "He’s about to vanish." : "Put Rudolph’s nose back on your phone, then tap “Pin it.”"}</p></div></div>`;
}

function revealHTML() {
  const k = state.kind, rv = fillLists(state.reveal || {});
  const pts = rv.pts || {};
  if (k === "trivia") {
    return `<h1 class="q">${esc(rv.text)}</h1>${withPhotos(rv.photos, tilesHTML(rv.options, rv))}<div class="under">` +
      (rv.right.length ? `Got it: ${faces(rv.right)}` : `<span class="muted">Nobody got this one.</span>`) +
      (rv.fact ? `<p class="fact" style="margin-top:.4em">${esc(rv.fact)}</p>` : "") + `</div>`;
  }
  if (k === "nose") {
    const pins = rv.pins || [];
    const svg = `<svg viewBox="0 0 100 100" role="img" aria-label="Where everyone pinned the nose">${deerSVG(rv.pose)}` +
      pins.slice().reverse().map((p) => `${noseSVG(p.x, p.y, 2.6, p.best ? "best" : "")}<text class="pin-label" x="${p.x * 100}" y="${p.y * 100 - 3.6}" text-anchor="middle">${esc(person(p.pid).avatar)}</text>`).join("") +
      `${noseSVG(rv.target.x, rv.target.y, 3.8 * rv.pose.s, "true")}</svg>`;
    const list = pins.slice(0, 6).map((p, i) => `<li class="${p.best ? "top" : ""}"><span class="rk">${i + 1}</span><span class="avatar">${esc(person(p.pid).avatar)}</span><span class="nm">${esc(person(p.pid).name)}<small>${Math.round(p.d * 100)} cm off</small></span><span class="pt">+${points(pts[p.pid] || 0)}</span></li>`).join("");
    return `<div class="split"><div class="deerbox">${svg}</div><div class="side"><h2>${pins.length ? `Closest: ${tag(pins[0].pid)}` : "Nobody pinned a nose!"}</h2>` +
      (pins.length ? `<ol class="ranked">${list}</ol>` : "") + `<p class="small-note muted" style="font-size:.85em">The box is 1 metre wide, if you’re wondering what “cm” means here.</p></div></div>`;
  }
  if (k === "closest") {
    const list = (rv.guesses || []).slice(0, 8).map((g) => `<li class="${g.rank === 1 ? "top" : ""}"><span class="rk">${g.rank}</span><span class="avatar">${esc(person(g.pid).avatar)}</span><span class="nm">${esc(person(g.pid).name)}<small>${numText(g.v, rv.unit)}${g.diff === 0 ? " · exact! 🎯" : ` · off by ${points(+g.diff.toFixed(2))}`}</small></span><span class="pt">+${points(pts[g.pid] || 0)}</span></li>`).join("");
    return `<p class="prompt">${esc(rv.text)}</p><p class="answer-big">${numText(rv.answer, rv.unit)}${rv.unit ? `<small>${esc(rv.unit)}</small>` : ""}</p>` +
      (rv.fact ? `<p class="under fact" style="margin:0 0 .8em">${esc(rv.fact)}</p>` : "") +
      (list ? `<ol class="ranked" style="max-width:34em;margin:0 auto;width:100%">${list}</ol>` : `<p class="under muted">Nobody guessed.</p>`);
  }
  if (k === "fake") {
    const opts = (rv.options || []).map((o) => {
      const by = o.truth ? `<span class="tag">✓ The real answer</span>` : o.house ? "A house fake 🎅" : o.authors.length ? `Fake by ${o.authors.map(tag).join(", ")}` : "";
      const fooled = !o.truth && o.voters.length ? ` · fooled ${o.voters.length}` : "";
      return `<div class="opt${o.truth ? " truth" : ""}"><span class="tx">${esc(o.text)}</span><span class="meta">${by}${fooled}${o.voters.length ? `<br>Picked by ${faces(o.voters)}` : ""}</span></div>`;
    }).join("");
    return `<h1 class="q" style="margin-bottom:.5em">${blanks(rv.text)}</h1><div class="opts revealed">${opts}</div>${rv.fact ? `<p class="under fact">${esc(rv.fact)}</p>` : ""}`;
  }
  if (k === "who") {
    return `<p class="prompt">${esc(rv.prompt)}</p><p class="quote">${esc(rv.answer)}</p><p class="reveal-who">It was ${tag(rv.author)}!</p>` +
      `<p class="under">${rv.right.length ? `Guessed right: ${faces(rv.right)}` : "Nobody guessed it."}${rv.fooled ? ` <span class="muted">· fooled ${plural(rv.fooled, "person", "people")}</span>` : ""}</p>`;
  }
  if (k === "vote") {
    const ids = Object.keys(rv.counts || {}).sort((a, b) => rv.counts[b] - rv.counts[a]);
    const max = Math.max(1, ...ids.map((p) => rv.counts[p]));
    const rows = ids.slice(0, 8).map((p) => `<li class="${rv.winners.includes(p) ? "win" : ""}"><span class="avatar">${esc(person(p).avatar)}</span><span class="nm">${esc(person(p).name)}</span><span class="track"><i style="width:${(rv.counts[p] / max) * 100}%"></i></span><span class="n">${rv.counts[p]}</span></li>`).join("");
    return `<p class="prompt">The room has spoken</p><h1 class="q">${esc(rv.text)}</h1>` +
      (rv.winners.length ? `<p class="reveal-who">${rv.winners.map(tag).join(" &amp; ")}</p><ul class="votes" aria-label="Votes">${rows}</ul><p class="under muted">Everyone who voted with the crowd gets 300 points.</p>` : `<p class="under muted">No votes this time.</p>`);
  }
  return "";
}

function boardHTML(list) {
  const max = Math.max(1, ...list.map((b) => b.score));
  return `<ol class="board">${list.slice(0, 10).map((b, i) => `<li class="${i === 0 && b.score > 0 ? "lead" : ""}"><span class="rk">${i + 1}</span><span class="avatar">${esc(person(b.pid).avatar)}</span><span class="nm">${esc(person(b.pid).name)}</span><span class="track"><i style="width:${(b.score / max) * 100}%"></i></span><span class="pt">${points(b.score)}</span><span class="dl">${b.delta ? "+" + points(b.delta) : ""}</span></li>`).join("")}</ol>`;
}

function scoresHTML() {
  return `<h1 class="title">Scores after round ${state.round.num} of ${state.round.of}</h1>${boardHTML(state.board || [])}`;
}

function finalHTML() {
  const b = state.board || [];
  const spot = (x, n) => x ? `<div class="spot p${n}"><span class="avatar">${esc(person(x.pid).avatar)}</span><span class="nm">${esc(person(x.pid).name)}</span><span class="pt">${points(x.score)}</span><div class="step">${n}</div></div>` : "";
  return `<h1 class="title">🏆 ${b[0] ? `${esc(person(b[0].pid).name)} wins ${GAME_NAME}!` : "That’s a wrap!"}</h1>` +
    `<div class="podium">${spot(b[1], 2)}${spot(b[0], 1)}${spot(b[2], 3)}</div>` +
    (b.length > 3 ? `<ol class="rest" start="4">${b.slice(3).map((x, i) => `<li>${i + 4}. ${tag(x.pid)} · ${points(x.score)}</li>`).join("")}</ol>` : "");
}

// ---------- timer ----------

setInterval(() => {
  if (!db || !INPUT.has(state.phase) || !state.deadline) { timerEl.textContent = ""; return; }
  const now = db.now(), left = state.deadline - now, secs = Math.max(0, Math.ceil(left / 1000));
  timerEl.textContent = secs;
  timerEl.classList.toggle("low", secs <= 5);
  if (secs !== lastSecond) {
    lastSecond = secs;
    if (secs > 0 && secs <= 5) sfx.tick(secs === 1);
  }
  if (state.kind === "nose" && state.phase === "ask") {
    const c = document.getElementById("nosecount"), pl = state.startedAt + NOSE_PREVIEW_MS - now;
    if (c && pl > 0) c.textContent = Math.ceil(pl / 1000);
    if (pl <= 0 && !noseHidden) { noseHidden = true; renderStage(); }
  }
  if (left <= 0 && answersReady && endingKey !== state.key) { endingKey = state.key; endStage(); }
}, 200);

// ---------- input ----------

nextBtn.addEventListener("click", next);
document.addEventListener("keydown", (e) => {
  if (e.target !== document.body || e.repeat) return;
  if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") { e.preventDefault(); if (!nextBtn.hidden && !nextBtn.disabled) next(); }
});
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act, k = t.dataset.k;
  if (act === "reload") location.reload();
  else if (act === "mute") { sfx.toggle(); sfx.unlock(); renderTop(); }
  else if (act === "toggle") { settings[k].on = !settings[k].on; saveSettings(); renderStage(); }
  else if (act === "inc" || act === "dec") {
    const top = roundMax(k);
    const n = Math.max(1, Math.min(top, Math.min(settings[k].n, top) + (act === "inc" ? 1 : -1)));
    // Family trivia turned all the way up means "all of them", so questions added later are included.
    settings[k].n = ROUNDS[k].pool === "family" && n >= top ? ROUNDS[k].max : n;
    saveSettings(); renderStage();
  } else if (act === "kick") {
    const pid = t.dataset.pid;
    await db.remove(`${room}/players/${pid}`);
    await db.remove(`${room}/about/${pid}`);
  } else if (act === "phone") {
    const n = Object.keys(players).length + 1 + Math.floor(Math.random() * 1000);
    window.open(`./?room=${code}&p=${n}${params.has("practice") ? "&practice" : ""}`, "_blank");
  } else if (act === "lobby") {
    if (confirm("End this game and go back to the lobby? Scores will be cleared when the next game starts.")) backToLobby();
  } else if (act === "unlock") {
    $("#photoerr").hidden = true;
    $("#photodlg").showModal();
    $("#photopass").focus();
  } else if (act === "resume" && resumeOffer) {
    openRoom(resumeOffer.saved.code, resumeOffer.st, resumeOffer.saved.plan);
    resumeOffer = null;
  } else if (act === "fresh") {
    if (resumeOffer) db.remove(`rooms/${resumeOffer.saved.code}`);
    resumeOffer = null;
    createRoom();
  }
});
addEventListener("load", () => { if (state.phase === "lobby") renderStage(); });
$("#photocancel").addEventListener("click", () => $("#photodlg").close());
$("#photoform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#photopass"), err = $("#photoerr"), ok = $("#photook");
  ok.disabled = true; ok.textContent = "Checking…"; err.hidden = true;
  const good = await photos.unlock(input.value);
  ok.disabled = false; ok.textContent = "Unlock";
  if (good) { input.value = ""; $("#photodlg").close(); renderStage(); }
  else { err.hidden = false; err.textContent = "That password didn’t work. Check for typos and try again."; input.select(); }
});

boot();
