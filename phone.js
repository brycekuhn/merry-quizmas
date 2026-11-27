// The phone screen. It joins a room, shows what the TV is doing and sends this player's answers.
import {
  connect, CHOICES, AVATARS, NAME_MAX, CODE_RE, NOSE_PREVIEW_MS, GAME_NAME,
  esc, uid, norm, hash, lsGet, lsSet, points, plural, numText, deerSVG, noseSVG, fillLists,
} from "./game.js";

const params = new URLSearchParams(location.search);
const ME_KEY = "mq-me" + (params.get("p") || ""); // ?p=2 gives a second player in the same browser (for testing)
const INPUT = new Set(["ask", "write", "pick"]);
const app = document.getElementById("app");

let db, content;
let me = lsGet(ME_KEY);
let room = null, state = {}, players = {}, scores = {}, myAbout = null;
let view = "loading";
let stops = [], stopMine = null, mineKey = null, mine = null;
let draft = { code: "", name: "", avatar: "" }, joinError = "";
let draftKey = null, pin = null, fakeError = "", myFake = null, myFakeKey = null, aboutSkipped = false, autoTimer = null;
let lastSig = "";

// ---------- start ----------

async function boot() {
  app.innerHTML = `<div class="center" style="margin:auto"><div class="huge">🎄</div><p class="lead">Warming up the cocoa…</p></div>`;
  try {
    [db, content] = await Promise.all([
      connect({ practice: params.has("practice") }),
      fetch("content.json", { cache: "no-store" }).then((r) => r.json()),
    ]);
  } catch (e) {
    app.innerHTML = `<div class="center" style="margin:auto"><div class="huge">😬</div><h1>Couldn’t connect</h1><p class="lead">${esc(e.message || e)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  const urlCode = (params.get("room") || "").toUpperCase();
  if (me && me.code && (!urlCode || urlCode === me.code) && (await db.get(`rooms/${me.code}/players/${me.pid}/name`))) {
    enter(me.code);
    return;
  }
  draft = { code: urlCode || (me && me.code) || "", name: (me && me.name) || "", avatar: (me && me.avatar) || AVATARS[Math.floor(Math.random() * AVATARS.length)] };
  view = "join";
  render(true);
}

async function join() {
  const code = draft.code.trim().toUpperCase(), name = draft.name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!CODE_RE.test(code)) return fail("Enter the 4-letter code from the TV.");
  if (!name) return fail("Type your name so everyone knows who’s winning.");
  const btn = app.querySelector('[data-act="join"]');
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  if (!(await db.get(`rooms/${code}/meta`))) return fail(`There’s no game with the code ${code}. Check the TV and try again.`);
  const pid = me && me.pid ? me.pid : uid();
  const old = await db.get(`rooms/${code}/players/${pid}`);
  await db.update(`rooms/${code}/players/${pid}`, { name, avatar: draft.avatar, joined: (old && old.joined) || db.now() });
  me = { pid, code, name, avatar: draft.avatar };
  lsSet(ME_KEY, me);
  enter(code);
}
function fail(msg) { joinError = msg; render(true); }

function enter(code) {
  stops.forEach((f) => f && f());
  room = `rooms/${code}`;
  view = "game";
  let seen = false;
  stops = [
    db.on(`${room}/state`, (v) => { state = v || { phase: "gone" }; onState(); }),
    db.on(`${room}/players`, (v) => {
      players = v || {};
      const p = players[me.pid];
      if (p && p.name) seen = true;
      if (seen && (!p || !p.name)) { view = "removed"; render(true); return; }
      render();
    }),
    db.on(`${room}/scores`, (v) => { scores = v || {}; render(); }),
    db.on(`${room}/about/${me.pid}`, (v) => { myAbout = v; render(); }),
  ];
  stops.push(db.presence(`${room}/players/${me.pid}/online`));
  render(true);
}

function onState() {
  if (state.key && state.key !== mineKey) {
    if (stopMine) stopMine();
    mineKey = state.key; mine = null;
    stopMine = db.on(`${room}/answers/${state.key}/${me.pid}`, (v) => { mine = v; render(); });
  }
  if (state.key !== draftKey) { draftKey = state.key; pin = null; fakeError = ""; clearTimeout(autoTimer); autoTimer = null; }
  if (state.phase === "pick" && state.q && state.q.writeKey !== myFakeKey) {
    myFakeKey = state.q.writeKey; myFake = null;
    db.get(`${room}/answers/${myFakeKey}/${me.pid}`).then((v) => { myFake = v && v.v; render(true); });
  }
  render();
}

// ---------- helpers ----------

const person = (pid) => (players[pid] && players[pid].name ? players[pid] : { name: "Someone", avatar: "❔" });
function rankOf(pid) {
  const list = Object.keys(players).filter((p) => players[p].name).sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
  const mineScore = scores[pid] || 0;
  return 1 + list.filter((p) => (scores[p] || 0) > mineScore).length;
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function timeUp() { return INPUT.has(state.phase) && state.deadline && db.now() > state.deadline + 300; }
function previewOn() { return state.kind === "nose" && state.phase === "ask" && db.now() < state.startedAt + NOSE_PREVIEW_MS; }
function blanks(text) { return esc(text).replace(/_{2,}/g, '<span class="blank"></span>'); }
function aboutPrompts() {
  const all = (content && content.aboutYou) || [];
  return all.slice().sort((a, b) => hash(me.pid + a).localeCompare(hash(me.pid + b))).slice(0, 2);
}
function isMineWho() {
  const q = state.q || {};
  return Object.values(myAbout || {}).some((e) => e && e.p === q.prompt && String(e.a || "").trim().slice(0, 80) === q.answer);
}

function send(v, extra = {}) {
  if (!INPUT.has(state.phase) || mine || timeUp()) return;
  mine = { v, t: db.now(), ...extra };
  db.set(`${room}/answers/${state.key}/${me.pid}`, mine);
  if (navigator.vibrate) navigator.vibrate(25);
  render(true);
}

// ---------- render ----------

function render(force) {
  // Re-render only when something on screen changes, so typing in a box is never wiped.
  const waiting = state.phase === "lobby" && (myAbout || aboutSkipped);
  const settled = view === "game" && me && !INPUT.has(state.phase) && state.phase !== "lobby";
  const sig = [view, state.seq, state.phase, mine ? 1 : 0, myAbout ? 1 : 0, aboutSkipped, previewOn(), timeUp(), myFake, fakeError, pin ? pin.x + "," + pin.y : 0, joinError,
    waiting ? Object.keys(players).length : "", settled ? (scores[me.pid] || 0) + ":" + rankOf(me.pid) : ""].join("|");
  if (!force && sig === lastSig) { paintTop(); return; }
  lastSig = sig;
  let html = "";
  if (view === "join" || view === "edit") html = joinHTML();
  else if (view === "removed") html = topHTML(false) + `<div class="center" style="margin:auto"><div class="huge">🫥</div><h1>You were removed from the game</h1><button class="btn primary" data-act="rejoin">Join again</button></div>`;
  else if (view === "game") html = topHTML(true) + gameHTML();
  app.innerHTML = html;
  const focus = app.querySelector("[data-autofocus]");
  if (focus && !("ontouchstart" in window)) focus.focus();
}

function topHTML(withMe) {
  const p = me ? person(me.pid) : null;
  return `<div class="bar-top"><span class="logo">${GAME_NAME}</span>` +
    (withMe && p ? `<span class="me" id="me"><span class="avatar">${esc(me.avatar)}</span><span>${esc(p.name === "Someone" ? me.name : p.name)}</span>${state.phase === "lobby" ? "" : `<span class="sc">${points(scores[me.pid] || 0)}</span>`}</span>` : "") + `</div>` +
    (INPUT.has(state.phase) && state.deadline ? `<div class="pbar" aria-hidden="true"><i id="pbar"></i></div>` : "");
}
function paintTop() {
  const sc = app.querySelector("#me .sc");
  if (sc && me) sc.textContent = points(scores[me.pid] || 0);
}

function joinHTML() {
  const editing = view === "edit";
  return `<div class="bar-top"><span class="logo">${GAME_NAME}</span></div>
  <h1>${editing ? "Change your name or picture" : "Join the game"}</h1>
  <div class="panel card">
    ${editing ? "" : `<div><label for="code">Room code</label><input id="code" class="code-in" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(draft.code)}" ${draft.code ? "" : "data-autofocus"}></div>`}
    <div><label for="name">Your name</label><input id="name" maxlength="${NAME_MAX}" autocomplete="nickname" value="${esc(draft.name)}" ${draft.code || editing ? "data-autofocus" : ""}></div>
    <div><label id="av-l">Pick a festive face</label><div class="avs" role="group" aria-labelledby="av-l">${AVATARS.map((a) => `<button data-av="${a}" aria-pressed="${draft.avatar === a}" aria-label="${a}">${a}</button>`).join("")}</div></div>
    ${joinError ? `<p class="err" role="alert">${esc(joinError)}</p>` : ""}
    <button class="btn primary wide" data-act="${editing ? "save-me" : "join"}">${editing ? "Save" : "Join"}</button>
    ${editing ? `<button class="link" data-act="cancel-edit">Cancel</button>` : ""}
  </div>
  ${editing ? "" : `<p class="small-note" style="text-align:center">Running the game? <a href="tv.html${params.has("practice") ? "?practice" : ""}" style="color:inherit">Open the TV screen</a> on a laptop or TV.</p>`}`;
}

function gameHTML() {
  const ph = state.phase, k = state.kind, q = state.q || {};
  if (ph === "gone") return `<div class="center" style="margin:auto"><div class="huge">🎁</div><h1>This game has ended</h1><button class="btn primary" data-act="rejoin">Join another game</button></div>`;
  if (ph === "lobby") return lobbyHTML();
  if (ph === "intro") {
    const r = state.round;
    return `<div class="center" style="margin:auto"><div class="huge">${r.icon}</div><p class="rank-line">Round ${r.num} of ${r.of}</p><h1>${esc(r.name)}</h1>${r.mult > 1 ? `<span class="badge">Double points</span>` : ""}<p class="lead">${esc(r.how)}</p><p class="small-note">Look at the TV. It’s about to start!</p></div>`;
  }
  if (ph === "reveal") return revealHTML();
  if (ph === "scores" || ph === "final") return standingHTML(ph === "final");
  if (!INPUT.has(ph)) return `<div class="center" style="margin:auto"><p class="lead">Look at the TV.</p></div>`;

  // input phases
  if (k === "who" && isMineWho()) {
    if (!mine && !autoTimer) {
      const key = state.key;
      autoTimer = setTimeout(() => { if (state.key === key) send("-", { mine: true }); }, 2500 + Math.random() * 3500);
    }
    return `<div class="center" style="margin:auto"><div class="huge">🤫</div><h1>That one’s yours!</h1><p class="lead">Keep a straight face. You score for everyone who guesses wrong.</p></div>`;
  }
  if (mine) return lockedHTML();
  if (timeUp()) return `<div class="center" style="margin:auto"><div class="huge">⏰</div><h1>Time’s up!</h1><p class="lead">Look at the TV.</p></div>`;

  if (k === "trivia") {
    return `${q.family ? `<p class="rank-line">🏡 Family question</p>` : ""}<h2>${esc(q.text)}</h2><div class="choices grid">${q.options.map((o, i) => `<button class="choice ${CHOICES[i].cls}" data-pick="${i}"><span class="ic">${CHOICES[i].icon}</span><span>${esc(o)}</span></button>`).join("")}</div>`;
  }
  if (k === "nose") return noseHTML();
  if (k === "closest") {
    return `<h2>${esc(q.text)}</h2><div class="panel card"><label for="num">Your guess${q.unit ? ` (${esc(q.unit)})` : ""}</label><input id="num" inputmode="decimal" autocomplete="off" placeholder="Type a number" data-autofocus><p class="err" id="num-err" role="alert" hidden></p><button class="btn primary wide" data-act="send-num">Lock it in</button></div>`;
  }
  if (k === "fake" && ph === "write") {
    return `<h2>${blanks(q.text)}</h2><div class="panel card"><label for="fake">Your fake answer</label><input id="fake" maxlength="40" autocomplete="off" placeholder="Something believable…" data-autofocus>${fakeError ? `<p class="err" role="alert">${esc(fakeError)}</p>` : ""}<button class="btn primary wide" data-act="send-fake">Submit my fake</button><p class="small-note">You get 500 points for every person your fake fools.</p></div>`;
  }
  if (k === "fake" && ph === "pick") {
    const own = norm(myFake || "");
    return `<h2>Which one is real?</h2><p class="lead">${blanks(q.text)}</p><div class="choices">${q.options.map((o) => {
      const isMine = own && norm(o.text) === own;
      return `<button class="choice plain" data-pick="${esc(o.id)}" ${isMine ? "disabled" : ""}>${esc(o.text)}${isMine ? " <small>(your fake 🤫)</small>" : ""}</button>`;
    }).join("")}</div>`;
  }
  if (k === "who") {
    return `<p class="lead">${esc(q.prompt)}</p><h2>“${esc(q.answer)}”</h2><p class="rank-line">Who wrote this?</p><div class="choices">${(q.choices || []).filter((p) => p !== me.pid && players[p] && players[p].name).map((p) => `<button class="choice plain" data-pick="${esc(p)}"><span class="avatar">${esc(person(p).avatar)}</span> ${esc(person(p).name)}</button>`).join("")}</div>`;
  }
  if (k === "vote") {
    return `<p class="lead">Vote for someone:</p><h2>${esc(q.text)}</h2><div class="choices">${(q.choices || []).filter((p) => p !== me.pid && players[p] && players[p].name).map((p) => `<button class="choice plain" data-pick="${esc(p)}"><span class="avatar">${esc(person(p).avatar)}</span> ${esc(person(p).name)}</button>`).join("")}</div>`;
  }
  return "";
}

function lobbyHTML() {
  if (!myAbout && !aboutSkipped) {
    const ps = aboutPrompts();
    return `<h1>While you wait…</h1><p class="lead">Answer two quick questions about yourself. They’ll come back later, and everyone will try to guess who wrote them.</p>
    <div class="panel card">${ps.map((p, i) => `<div><label for="ab${i}">${esc(p)}</label><input id="ab${i}" data-prompt="${esc(p)}" maxlength="80" autocomplete="off" ${i === 0 ? "data-autofocus" : ""}></div>`).join("")}
    <button class="btn primary wide" data-act="save-about">Save my answers</button><button class="link" data-act="skip-about">Skip</button></div>`;
  }
  const p = person(me.pid);
  return `<div class="center" style="margin:auto"><div class="huge">${esc(me.avatar)}</div><h1>You’re in, ${esc(p.name === "Someone" ? me.name : p.name)}!</h1><p class="lead">Look at the TV. The game starts when the host is ready.</p>
    <p class="small-note">${plural(Object.values(players).filter((x) => x.name).length, "player")} so far</p>
    <button class="link" data-act="edit">Change my name or picture</button>${myAbout ? `<button class="link" data-act="redo-about">Change my answers</button>` : ""}</div>`;
}

function lockedHTML() {
  const k = state.kind, q = state.q || {}, v = mine.v;
  let what = "";
  if (k === "trivia" && q.options) what = `<div class="choice ${CHOICES[v].cls}" style="min-height:64px;width:100%"><span class="ic">${CHOICES[v].icon}</span>${esc(q.options[v])}</div>`;
  else if (k === "closest") what = `<p class="result">${esc(numText(Number(v), q.unit))}</p>`;
  else if (k === "fake" && state.phase === "write") what = `<p class="lead">Your fake: <b>${esc(v)}</b></p>`;
  else if (k === "fake") { const o = (q.options || []).find((x) => x.id === v); what = o ? `<p class="lead">You picked <b>${esc(o.text)}</b></p>` : ""; }
  else if (k === "who" || k === "vote") what = `<p class="lead">You picked <span class="avatar">${esc(person(v).avatar)}</span> <b>${esc(person(v).name)}</b></p>`;
  else if (k === "nose") what = `<div class="deerbox" style="max-width:260px"><svg viewBox="0 0 100 100" aria-hidden="true">${noseSVG(v.x, v.y, 3.6)}</svg></div>`;
  return `<div class="center" style="margin:auto"><div class="huge">🔒</div><h1>Locked in!</h1>${what}<p class="small-note">Watch the TV for the answer.</p></div>`;
}

function noseHTML() {
  const q = state.q, preview = previewOn();
  const left = Math.ceil((state.startedAt + NOSE_PREVIEW_MS - db.now()) / 1000);
  return `<h2>${preview ? "Remember where his nose goes!" : "Tap where Rudolph’s nose goes"}</h2>
  <div class="deerbox" id="deerbox" role="${preview ? "img" : "button"}" aria-label="${preview ? "The reindeer, before he vanishes" : "Tap to place the nose"}">
    <svg viewBox="0 0 100 100" aria-hidden="true">${preview ? deerSVG(q.pose) : ""}${pin ? noseSVG(pin.x, pin.y, 3.6) : ""}</svg>
    ${preview ? `<span class="count" id="nosecount">${left}</span>` : pin ? "" : `<div class="veil clear"><div><span class="ic">👆</span>Tap anywhere in the box</div></div>`}
  </div>
  <button class="btn primary wide" data-act="send-pin" ${pin && !preview ? "" : "disabled"}>${pin ? "Pin it! 📌" : "Tap the box first"}</button>
  ${pin ? `<p class="small-note" style="text-align:center">Not quite right? Tap again to move it.</p>` : ""}`;
}

function revealHTML() {
  const k = state.kind, rv = fillLists(state.reveal || {}), pts = (rv.pts || {})[me.pid] || 0;
  const v = mine && mine.v;
  let head = "", line = "";
  if (k === "trivia") {
    const ok = v === rv.answer;
    head = mine ? (ok ? "Correct!" : "Not quite") : "No answer";
    line = ok ? "" : `The answer was <b>${esc(rv.options[rv.answer])}</b>.`;
  } else if (k === "nose") {
    const p = (rv.pins || []).find((x) => x.pid === me.pid);
    head = p ? (p.best ? "Closest nose! 🏅" : `${Math.round(p.d * 100)} cm off`) : "No nose pinned";
    line = p && !p.best ? "Look at the TV to see everyone’s noses." : "";
  } else if (k === "closest") {
    const g = (rv.guesses || []).find((x) => x.pid === me.pid);
    head = g ? (g.diff === 0 ? "Exactly right! 🎯" : g.rank <= 3 ? `${ordinal(g.rank)} closest!` : "Good try") : "No guess";
    line = `The answer was <b>${esc(numText(rv.answer, rv.unit))}${rv.unit ? " " + esc(rv.unit) : ""}</b>.${g ? ` You said ${esc(numText(g.v, rv.unit))}.` : ""}`;
  } else if (k === "fake") {
    const opts = rv.options || [];
    const picked = opts.find((o) => o.voters.includes(me.pid));
    const mineOpt = opts.find((o) => o.authors.includes(me.pid));
    head = picked && picked.truth ? "You found the truth!" : picked ? "Fooled you!" : "No vote";
    line = `The real answer: <b>${esc(rv.answer)}</b>.` + (mineOpt ? ` Your fake fooled ${plural(mineOpt.voters.filter((p) => p !== me.pid).length, "person", "people")}.` : "");
  } else if (k === "who") {
    if (rv.author === me.pid) { head = "It was you!"; line = `You fooled ${plural(rv.fooled || 0, "person", "people")}.`; }
    else { head = rv.right.includes(me.pid) ? "You got it!" : "Nope!"; line = `It was <span class="avatar">${esc(person(rv.author).avatar)}</span> <b>${esc(person(rv.author).name)}</b>.`; }
  } else if (k === "vote") {
    const won = rv.winners.includes(me.pid);
    head = won ? "The room picked you! 👑" : rv.winners.includes(v) ? "You voted with the crowd!" : "Not the crowd’s pick";
    line = rv.winners.length ? `Most votes: ${rv.winners.map((p) => `<b>${esc(person(p).name)}</b>`).join(" and ")}.` : "";
  }
  const rank = rankOf(me.pid);
  return `<div class="center" style="margin:auto"><p class="result ${pts ? "good" : "meh"}">${pts ? "+" + points(pts) : "+0"}</p><h1>${head}</h1>${line ? `<p class="lead">${line}</p>` : ""}
    <p class="rank-line">You have <b>${points(scores[me.pid] || 0)}</b> points, in <b>${ordinal(rank)}</b> place.</p></div>`;
}

function standingHTML(final) {
  const rank = rankOf(me.pid), score = scores[me.pid] || 0;
  const medal = ["🥇", "🥈", "🥉"][rank - 1] || "🎄";
  if (final) {
    return `<div class="center" style="margin:auto"><div class="huge">${medal}</div><h1>You finished ${ordinal(rank)}!</h1><p class="rank-line"><b>${points(score)}</b> points</p><p class="lead">Thanks for playing ${GAME_NAME}. Merry Christmas!</p></div>`;
  }
  const delta = (state.board || []).find((b) => b.pid === me.pid);
  return `<div class="center" style="margin:auto"><div class="huge">${medal}</div><h1>You’re in ${ordinal(rank)} place</h1><p class="rank-line"><b>${points(score)}</b> points${delta && delta.delta ? ` · +${points(delta.delta)} this round` : ""}</p><p class="small-note">Next round coming up. Look at the TV.</p></div>`;
}

// ---------- events ----------

app.addEventListener("input", (e) => {
  if (e.target.id === "code") { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ""); draft.code = e.target.value; }
  if (e.target.id === "name") draft.name = e.target.value;
});
app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches("input")) return;
  e.preventDefault();
  const btn = app.querySelector(".btn.primary.wide");
  if (btn && !btn.disabled) btn.click();
});
app.addEventListener("click", async (e) => {
  const av = e.target.closest("[data-av]");
  if (av) { draft.avatar = av.dataset.av; app.querySelectorAll("[data-av]").forEach((b) => b.setAttribute("aria-pressed", b === av)); return; }
  const box = e.target.closest("#deerbox");
  if (box && state.kind === "nose" && !previewOn() && !mine && !timeUp()) {
    const r = box.getBoundingClientRect();
    pin = { x: +((e.clientX - r.left) / r.width).toFixed(4), y: +((e.clientY - r.top) / r.height).toFixed(4) };
    render(true);
    return;
  }
  const pick = e.target.closest("[data-pick]");
  if (pick && !pick.disabled) {
    const raw = pick.dataset.pick;
    send(state.kind === "trivia" ? Number(raw) : raw);
    return;
  }
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "join") { joinError = ""; await join(); }
  else if (act === "edit") { draft = { code: me.code, name: person(me.pid).name, avatar: me.avatar }; joinError = ""; view = "edit"; render(true); }
  else if (act === "cancel-edit") { view = "game"; render(true); }
  else if (act === "save-me") {
    const name = draft.name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
    if (!name) return fail("Type your name.");
    await db.update(`${room}/players/${me.pid}`, { name, avatar: draft.avatar });
    me = { ...me, name, avatar: draft.avatar }; lsSet(ME_KEY, me);
    view = "game"; joinError = ""; render(true);
  } else if (act === "rejoin") {
    stops.forEach((f) => f && f()); stops = [];
    draft = { code: "", name: me ? me.name : "", avatar: me ? me.avatar : AVATARS[0] };
    if (me) { me = { ...me, code: "" }; lsSet(ME_KEY, me); }
    view = "join"; render(true);
  } else if (act === "save-about") {
    const list = [...app.querySelectorAll("[data-prompt]")].map((i) => ({ p: i.dataset.prompt, a: i.value.trim().slice(0, 80) })).filter((x) => x.a);
    await db.set(`${room}/about/${me.pid}`, list.length ? list : { skipped: true });
  } else if (act === "skip-about") { await db.set(`${room}/about/${me.pid}`, { skipped: true }); }
  else if (act === "redo-about") { await db.remove(`${room}/about/${me.pid}`); aboutSkipped = false; }
  else if (act === "send-num") {
    const input = app.querySelector("#num"), err = app.querySelector("#num-err");
    const n = Number(String(input.value).replace(/[, $]/g, ""));
    if (!input.value.trim() || !Number.isFinite(n)) { err.hidden = false; err.textContent = "Type a number, like 1843."; input.focus(); return; }
    send(n);
  } else if (act === "send-fake") {
    const input = app.querySelector("#fake"), text = input.value.trim();
    if (!text) { fakeError = "Write something first."; render(true); return; }
    if ((state.q.truth || []).includes(hash(norm(text)))) { fakeError = "Whoa, that’s the real answer! Keep it secret and write a fake one instead."; render(true); return; }
    send(text);
  } else if (act === "send-pin" && pin) send(pin);
});

// Countdown bar, the nose preview, and "time's up".
setInterval(() => {
  if (!db || view !== "game") return;
  const bar = document.getElementById("pbar");
  if (bar && state.deadline) bar.style.width = Math.max(0, Math.min(100, ((state.deadline - db.now()) / (state.deadline - state.startedAt)) * 100)) + "%";
  const c = document.getElementById("nosecount");
  if (c) c.textContent = Math.max(1, Math.ceil((state.startedAt + NOSE_PREVIEW_MS - db.now()) / 1000));
  render();
}, 250);

document.addEventListener("visibilitychange", () => { if (!document.hidden) render(true); });

boot();
