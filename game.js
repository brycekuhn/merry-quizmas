// Shared by the TV page (tv.js) and the phone page (phone.js):
// the live-sync layer, round definitions, text helpers and the reindeer art.
import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "13.4.0";

export const GAME_NAME = "Merry Quizmas";
export const AVATARS = ["🎅", "🤶", "🧝", "🦌", "⛄", "🎄", "🍪", "🎁", "🐧", "🔔", "⭐", "🧦", "🍬", "🧸", "🛷", "🧣"];
// Answer tiles. Colours were checked for colour-blind separation on the dark TV background;
// each tile also has its own icon and text, so colour is never the only cue.
export const CHOICES = [
  { icon: "🔔", cls: "c0" },
  { icon: "🎄", cls: "c1" },
  { icon: "⭐", cls: "c2" },
  { icon: "🎁", cls: "c3" },
];
export const NAME_MAX = 14;
export const CODE_RE = /^[A-Z]{4}$/;
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels, so a room code can't spell a word

// Every round the host can turn on, in the order they're played.
// "kind" is the game mechanic; "final" is trivia worth double.
export const ROUNDS = {
  trivia: { kind: "trivia", name: "Christmas trivia", icon: "🎄", n: 6, max: 12,
    how: "Pick the right answer on your phone. The faster you answer, the more points you get." },
  nose: { kind: "nose", name: "Pin the nose on the reindeer", icon: "🦌", n: 3, max: 6,
    how: "Rudolph has lost his nose! He appears for 3 seconds, then vanishes. Tap where his nose should go. The closer you are, the more points you get." },
  closest: { kind: "closest", name: "Closest guess", icon: "🎯", n: 4, max: 10,
    how: "Type a number. The three closest guesses score, and an exact answer earns a bonus." },
  fake: { kind: "fake", name: "Fake fact", icon: "🤥", n: 4, max: 10,
    how: "Every tradition here is real. First, write a fake answer to fool everyone. Then find the real one among the fakes." },
  who: { kind: "who", name: "Who said that?", icon: "🕵️", n: 6, max: 12,
    how: "Remember the questions you answered when you joined? Guess who wrote each answer. You score when people guess wrong about yours." },
  vote: { kind: "vote", name: "Most likely to…", icon: "🏆", n: 4, max: 10,
    how: "Vote for someone in the room. If you vote with the crowd, you score." },
  final: { kind: "trivia", name: "Final trivia", icon: "✨", n: 4, max: 10, mult: 2,
    how: "Last round, and every answer is worth double. Anyone can still win." },
};
export const ROUND_ORDER = ["trivia", "nose", "closest", "fake", "who", "vote", "final"];

export const DURATION = { trivia: 20, nose: 18, closest: 25, write: 50, fakevote: 30, who: 25, vote: 20 };
export const NOSE_PREVIEW_MS = 3000;

// ---------- small helpers ----------

export function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function uid(n = 10) {
  const a = "abcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  for (const x of crypto.getRandomValues(new Uint8Array(n))) s += a[x % a.length];
  return s;
}
export function makeCode() {
  let s = "";
  for (const x of crypto.getRandomValues(new Uint8Array(4))) s += CODE_LETTERS[x % CODE_LETTERS.length];
  return s;
}
export function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Loose match for typed answers: case, accents, punctuation, "a/an/the" and plural "s" don't matter.
export function norm(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^(a|an|the) /, "")
    .split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
}
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export function lsGet(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
export function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
export function points(n) { return n.toLocaleString("en-CA"); }
// Numbers for "closest guess": years read as 1990, not 1,990.
export function numText(n, unit) {
  return !unit && Number.isInteger(n) && n >= 1000 && n <= 2999 ? String(n) : points(n);
}

// Firebase drops empty lists (and turns sparse ones into objects), so a reveal read back from the
// database can be missing "nobody" lists. Put them back before anything calls .length or .includes.
export function fillLists(rv) {
  const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
  const out = { ...rv, right: list(rv.right), winners: list(rv.winners), pins: list(rv.pins), guesses: list(rv.guesses), counts: rv.counts || {} };
  if (rv.options) out.options = list(rv.options).map((o) => (typeof o === "object" && o ? { ...o, authors: list(o.authors), voters: list(o.voters) } : o));
  return out;
}

// ---------- reindeer art (original drawing, 100 × 100 box) ----------

const NOSE = { x: 50, y: 61.5 };
const DEER = `
<g fill="none" stroke="#7A4E2A" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M42 28 C39 19 33 12 24 6"/><path d="M36 18 C31 17.5 26 19.5 21 24"/><path d="M31 11.5 C32 7.5 34.5 4.5 38 2.5"/>
  <path d="M58 28 C61 19 67 12 76 6"/><path d="M64 18 C69 17.5 74 19.5 79 24"/><path d="M69 11.5 C68 7.5 65.5 4.5 62 2.5"/>
</g>
<ellipse cx="28.5" cy="38" rx="9.5" ry="4.6" transform="rotate(-24 28.5 38)" fill="#8B5A33"/>
<ellipse cx="29.5" cy="38" rx="5.6" ry="2.2" transform="rotate(-24 29.5 38)" fill="#E7B48C"/>
<ellipse cx="71.5" cy="38" rx="9.5" ry="4.6" transform="rotate(24 71.5 38)" fill="#8B5A33"/>
<ellipse cx="70.5" cy="38" rx="5.6" ry="2.2" transform="rotate(24 70.5 38)" fill="#E7B48C"/>
<path d="M50 26 C63 26 69.5 35 68.5 46 C67.5 56 62 62 60 68 C58 74 54.5 77.5 50 77.5 C45.5 77.5 42 74 40 68 C38 62 32.5 56 31.5 46 C30.5 35 37 26 50 26 Z" fill="#9C6539"/>
<path d="M50 29 C57 29 61 33 61 38 C61 42 56 44 50 44 C44 44 39 42 39 38 C39 33 43 29 50 29 Z" fill="#A9703F" opacity=".7"/>
<ellipse cx="50" cy="66" rx="11.5" ry="10" fill="#DDAE80"/>
<circle cx="42.5" cy="46" r="3.4" fill="#2A1A10"/><circle cx="43.6" cy="44.8" r="1.1" fill="#fff"/>
<circle cx="57.5" cy="46" r="3.4" fill="#2A1A10"/><circle cx="58.6" cy="44.8" r="1.1" fill="#fff"/>
<path d="M38.5 40.5 Q42.5 38 46 40" stroke="#5B3A20" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M54 40 Q57.5 38 61.5 40.5" stroke="#5B3A20" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M45.5 71 Q50 74.5 54.5 71" stroke="#5B3A20" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<circle cx="38.5" cy="55.5" r="2.6" fill="#E98A7A" opacity=".55"/><circle cx="61.5" cy="55.5" r="2.6" fill="#E98A7A" opacity=".55"/>`;
const DEER_BOX = [[20, 1], [80, 1], [20, 79], [80, 79]];

function place({ x, y, s, r }, px, py) {
  const a = (r * Math.PI) / 180, dx = (px - 50) * s, dy = (py - 50) * s;
  return [x + dx * Math.cos(a) - dy * Math.sin(a), y + dx * Math.sin(a) + dy * Math.cos(a)];
}
// A random position, size and tilt that keeps the whole reindeer in the box.
export function randomPose() {
  for (let t = 0; t < 200; t++) {
    const pose = {
      s: +(0.55 + Math.random() * 0.4).toFixed(3),
      r: Math.round(-30 + Math.random() * 60),
      x: +(22 + Math.random() * 56).toFixed(2),
      y: +(24 + Math.random() * 56).toFixed(2),
    };
    if (DEER_BOX.every(([px, py]) => { const [qx, qy] = place(pose, px, py); return qx > 3 && qx < 97 && qy > 3 && qy < 97; })) return pose;
  }
  return { s: 0.8, r: 0, x: 50, y: 52 };
}
// Where the nose belongs, as 0–1 fractions of the box.
export function noseAt(pose) {
  const [x, y] = place(pose, NOSE.x, NOSE.y);
  return { x: x / 100, y: y / 100 };
}
export function deerSVG(pose) {
  return `<g transform="translate(${pose.x} ${pose.y}) rotate(${pose.r}) scale(${pose.s}) translate(-50 -50)">${DEER}</g>`;
}
export function noseSVG(x, y, r = 3.6, cls = "") {
  return `<g class="nose ${cls}"><circle cx="${x * 100}" cy="${y * 100}" r="${r}" fill="#E0233C"/><circle cx="${x * 100 - r * 0.35}" cy="${y * 100 - r * 0.35}" r="${r * 0.32}" fill="#FFB3BC"/></g>`;
}

// ---------- live sync ----------
// Both backends expose the same small API over a JSON tree:
//   on(path, cb) -> unsubscribe, get(path), set(path, value), update(path, {subpath: value}), remove(path),
//   now() (shared clock in ms), presence(path) (true while connected), mode ("firebase" | "practice")

export async function connect({ practice = false } = {}) {
  if (practice || !firebaseConfig || !firebaseConfig.databaseURL) return practiceBackend();
  return firebaseBackend(firebaseConfig);
}

function cleanValue(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

async function firebaseBackend(config) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [appMod, dbMod, authMod] = await Promise.all([
    import(base + "firebase-app.js"),
    import(base + "firebase-database.js"),
    import(base + "firebase-auth.js"),
  ]);
  const app = appMod.initializeApp(config);
  try {
    await authMod.signInAnonymously(authMod.getAuth(app));
  } catch (e) {
    const err = new Error("Couldn’t sign in to Firebase. In the Firebase console, turn on Authentication > Sign-in method > Anonymous, and make sure this site’s domain is listed under Authentication > Settings > Authorized domains.");
    err.detail = e && e.code;
    throw err;
  }
  const db = dbMod.getDatabase(app);
  const ref = (p) => dbMod.ref(db, p);
  let offset = 0;
  dbMod.onValue(ref(".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });
  return {
    mode: "firebase",
    now: () => Date.now() + offset,
    on: (p, cb) => dbMod.onValue(ref(p), (s) => cb(s.val()), (e) => console.warn("listen failed", p, e)),
    get: (p) => dbMod.get(ref(p)).then((s) => s.val()),
    set: (p, v) => dbMod.set(ref(p), cleanValue(v)),
    update: (p, v) => dbMod.update(ref(p), cleanValue(v)),
    remove: (p) => dbMod.remove(ref(p)),
    presence(p) {
      return dbMod.onValue(ref(".info/connected"), (s) => {
        if (!s.val()) return;
        dbMod.onDisconnect(ref(p)).set(false);
        dbMod.set(ref(p), true);
      });
    },
  };
}

// Practice mode: the same tree kept in this browser and shared between its tabs.
// Good for trying the game on one computer (one tab as the TV, others as phones).
function practiceBackend() {
  const KEY = "mq-practice-db";
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("mq-practice") : null;
  let tree = lsGet(KEY) || {};
  const subs = new Set();
  const parts = (p) => String(p).split("/").filter(Boolean);
  const getAt = (ps) => { let n = tree; for (const k of ps) { if (n == null || typeof n !== "object") return null; n = n[k]; } return n === undefined ? null : n; };
  function setAt(ps, v) {
    if (!ps.length) { tree = v && typeof v === "object" ? v : {}; return; }
    const chain = [tree];
    let n = tree;
    for (let i = 0; i < ps.length - 1; i++) {
      if (n[ps[i]] == null || typeof n[ps[i]] !== "object") n[ps[i]] = {};
      n = n[ps[i]];
      chain.push(n);
    }
    const last = ps[ps.length - 1];
    if (v == null) delete n[last]; else n[last] = v;
    // Like Firebase, drop parents that become empty.
    for (let i = chain.length - 1; i > 0; i--) { if (Object.keys(chain[i]).length) break; delete chain[i - 1][ps[i - 1]]; }
  }
  function apply(op) {
    if (op.t === "set") setAt(parts(op.p), op.v);
    else if (op.t === "update") for (const [k, v] of Object.entries(op.v || {})) setAt(parts(op.p).concat(parts(k)), v);
    notify();
  }
  let saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => lsSet(KEY, tree), 50); }
  function notify() {
    for (const s of subs) {
      const val = getAt(s.ps);
      const j = JSON.stringify(val);
      if (j !== s.last) { s.last = j; s.cb(val == null ? null : JSON.parse(j)); }
    }
  }
  function write(op) {
    op.v = cleanValue(op.v);
    apply(op);
    if (channel) channel.postMessage(op);
    save();
    return Promise.resolve();
  }
  if (channel) channel.onmessage = (e) => { apply(e.data); save(); };
  return {
    mode: "practice",
    now: () => Date.now(),
    on(p, cb) {
      const s = { ps: parts(p), cb, last: undefined };
      subs.add(s);
      setTimeout(() => { if (!subs.has(s)) return; const v = getAt(s.ps); s.last = JSON.stringify(v); cb(v == null ? null : JSON.parse(s.last)); }, 0);
      return () => subs.delete(s);
    },
    get: (p) => Promise.resolve(cleanValue(getAt(parts(p)))),
    set: (p, v) => write({ t: "set", p, v }),
    update: (p, v) => write({ t: "update", p, v }),
    remove: (p) => write({ t: "set", p, v: null }),
    presence(p) { write({ t: "set", p, v: true }); return () => {}; },
    reset() { tree = {}; lsSet(KEY, tree); if (channel) channel.postMessage({ t: "set", p: "", v: {} }); notify(); },
  };
}
