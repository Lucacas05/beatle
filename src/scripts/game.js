import { CATALOG, GENRES, SNIPPETS } from "../data/catalog.js";

/* Built once: each genre -> array of {track, artist, genre} */
const LIBRARY = {};
for (const [id, list] of Object.entries(CATALOG)) {
  LIBRARY[id] = list.map((s) => {
    const [track, artist] = s.split("|");
    return { track, artist, genre: id };
  });
}
const ALL_SONGS = Object.keys(CATALOG).flatMap((id) => LIBRARY[id]);

const $ = (id) => document.getElementById(id);
const els = {
  rows: [...document.querySelectorAll("#rows .row")],
  segs: [...document.querySelectorAll("#segments .seg")],
  playBtn: $("playBtn"), playIcon: $("playIcon"), hint: $("hint"),
  form: $("guessForm"), input: $("guessInput"), submit: $("submitBtn"), skip: $("skipBtn"),
  playActions: $("playActions"), doneActions: $("doneActions"), retryActions: $("retryActions"),
  result: $("result"), head: $("resultHead"), sub: $("resultSub"),
  art: $("songArt"), title: $("songTitle"), artist: $("songArtist"), link: $("songLink"),
  toast: $("toast"), newSong: $("newSongBtn"), newSongTop: $("newSongTop"), retry: $("retryBtn"), share: $("shareBtn"),
  statStreak: $("statStreak"), statWinPct: $("statWinPct"), statPlayed: $("statPlayed"),
  streakTop: $("streakTop"), streakPill: $("streakPill"), howToPlay: $("howToPlay"),
  ac: $("acList"),
};

const ALL_TITLES = new Set();
const TITLE_TO_SONG = new Map();

let song = null;
let attempt = 0;
let results = [];          // "wrong" | "artist" | "skipped" | "right" per attempt
let playing = false;
let stopTimer = null;
let rafId = null;
let currentGenre = "reggaeton";
let loading = false;
let roundToken = 0;
let audio = null;
const recentTracks = [];

/* ---------- preview cache ---------- */
const CACHE_KEY = "beatle-previews-v1";
const previewCache = new Map(Object.entries((() => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
})()));
let cacheSaveTimer = null;
function persistCache() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(previewCache))); } catch {}
  }, 400);
}

const norm = (s) => (s || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\(.*?\)|\[.*?\]/g, " ")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(feat|ft|with|remastered|remaster|version|radio edit|single|deluxe)\b/g, " ")
  .replace(/\s+/g, " ").trim();

ALL_SONGS.forEach((s) => { ALL_TITLES.add(norm(s.track)); TITLE_TO_SONG.set(norm(s.track), s); });

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/* ---------- iTunes ---------- */
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = "itcb_" + Math.random().toString(36).slice(2);
    const s = document.createElement("script");
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error("load error")); };
    s.src = url + "&callback=" + cb;
    document.head.appendChild(s);
  });
}

async function resolvePreview(entry) {
  const key = entry.artist + "|" + entry.track;
  if (previewCache.has(key)) return previewCache.get(key);

  const q = `${entry.artist} ${entry.track}`;
  const data = await jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=12&country=US`);
  const wantT = norm(entry.track);
  const wantA = norm(entry.artist);
  let best = null, bestScore = -1;

  for (const t of (data && data.results) || []) {
    if (t.kind !== "song" || !t.previewUrl) continue;
    const gotT = norm(t.trackName);
    const gotA = norm(t.artistName);
    const titleOk = gotT === wantT || gotT.startsWith(wantT + " ") || levenshtein(gotT, wantT) <= 2;
    const artistOk = gotA.includes(wantA) || wantA.includes(gotA);
    if (!titleOk || !artistOk) continue;
    const meta = t.trackName + " " + (t.collectionName || "");
    if (/karaoke|tribute|instrumental|made popular by|originally performed|in the style of|8-bit|lullaby/i.test(meta)) continue;
    let score = (gotT === wantT ? 4 : 0) + (gotA === wantA ? 2 : 0);
    if (/live|remix|demo|sped up|slowed|acoustic|re-?recorded/i.test(meta)) score -= 3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (!best) return null;

  const found = {
    track: entry.track,
    artist: entry.artist,
    itunesTrack: best.trackName,
    art: (best.artworkUrl100 || "").replace("100x100", "400x400"),
    url: best.previewUrl,
    link: best.trackViewUrl,
  };
  previewCache.set(key, found);
  persistCache();
  return found;
}

/* ---------- rows & segments ---------- */
function renderRows() {
  els.rows.forEach((row, i) => {
    const r = results[i];
    row.className = "row";
    row.textContent = "";
    if (r) {
      row.classList.add(r.kind, "filled");
      row.textContent = r.kind === "skipped" ? "Skipped" : r.text;
    } else if (i === attempt && song && !song.done) {
      row.classList.add("current");
    }
  });
}

function renderSegments() {
  const unlocked = song ? Math.min(attempt + 1, SNIPPETS.length) : 0;
  els.segs.forEach((seg, i) => {
    seg.classList.toggle("unlocked", song && !song.done && i < unlocked);
    seg.querySelector("i").style.width = "0%";
  });
}

function setHint(html) { els.hint.innerHTML = html; }

function updateHint() {
  if (!song || song.done) return;
  const len = SNIPPETS[Math.min(attempt, SNIPPETS.length - 1)];
  const next = SNIPPETS[attempt + 1];
  setHint(`<strong>${len}s</strong> of audio` + (next ? ` · next unlock adds ${next - len}s` : " · last try"));
}

/* ---------- playback ---------- */
function setPlayingUI(on) {
  playing = on;
  els.playIcon.innerHTML = on ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  els.playBtn.setAttribute("aria-label", on ? "Pause" : "Play snippet");
}

function stopPlayback() {
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  if (audio) audio.pause();
  setPlayingUI(false);
  els.segs.forEach((s) => (s.querySelector("i").style.width = "0%"));
}

function playSnippet() {
  if (!song || song.done || playing) return;
  const len = SNIPPETS[Math.min(attempt, SNIPPETS.length - 1)];
  if (!audio) { audio = new Audio(); audio.preload = "auto"; }
  if (audio.src !== song.url) audio.src = song.url;
  try { audio.currentTime = 0; } catch {}
  setPlayingUI(true);
  const playStart = performance.now();
  const tick = () => {
    if (!playing) return;
    const elapsed = Math.min((performance.now() - playStart) / 1000, len);
    // fill segments proportionally to elapsed time (segments are sized by their length)
    let acc = 0;
    els.segs.forEach((seg, i) => {
      const segLen = SNIPPETS[i];
      const segStart = acc;
      acc += segLen;
      const f = Math.max(0, Math.min((elapsed - segStart) / segLen, 1));
      seg.querySelector("i").style.width = f * 100 + "%";
    });
    if (elapsed < len) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  audio.play().then(() => {
    stopTimer = setTimeout(stopPlayback, len * 1000);
  }).catch(() => {
    stopPlayback();
    showToast("Tap play again to listen");
  });
}

/* ---------- guessing ---------- */
function isCorrect(guess) {
  const g = norm(guess);
  if (!g) return false;
  const t = norm(song.track);
  if (!t) return false;
  if (g === t) return true;
  if (g === norm(song.artist + " " + song.track)) return true;
  if (g === norm(song.track + " " + song.artist)) return true;
  if (ALL_TITLES.has(g)) return false;
  const tol = t.length > 14 ? 3 : t.length > 7 ? 2 : 1;
  return levenshtein(g, t) <= tol;
}

function sameArtist(guess) {
  const s = TITLE_TO_SONG.get(norm(guess));
  return !!s && norm(s.artist) === norm(song.artist);
}

function lockGuess(lock) {
  els.input.disabled = lock;
  els.submit.disabled = lock;
  els.skip.disabled = lock;
}

function setMode(mode) {
  els.playActions.hidden = mode !== "play";
  els.doneActions.hidden = mode !== "done";
  els.retryActions.hidden = mode !== "retry";
  els.input.parentElement.style.display = mode === "play" ? "" : "none";
}

function endGame(won) {
  song.done = true;
  song.solved = won;
  stopPlayback();
  closeAC();
  lockGuess(true);
  els.playBtn.disabled = true;
  els.input.value = "";
  renderRows();
  renderSegments();
  const stats = bumpStats(won);
  renderStats(stats);
  const heard = SNIPPETS.slice(0, attempt).reduce((a, b) => a + b, 0);
  const praise = ["Genius", "Magnificent", "Impressive", "Splendid", "Great"];
  els.head.textContent = won ? praise[attempt - 1] || "Great" : "So close";
  els.sub.textContent = won
    ? `Got it in ${attempt} · ${heard} seconds of audio`
    : `The song was`;
  setHint("");
  els.art.src = song.art || "";
  els.art.alt = `Artwork for ${song.track}`;
  els.title.textContent = song.track;
  els.artist.textContent = song.artist;
  els.link.href = song.link || "#";
  els.link.style.display = song.link ? "" : "none";
  els.result.classList.add("show");
  setMode("done");
  els.newSong.focus();
}

function nextAttempt(delay) {
  if (attempt >= SNIPPETS.length) { endGame(false); return; }
  updateHint();
  renderRows();
  renderSegments();
  setTimeout(playSnippet, delay);
}

function onSubmit(e) {
  e.preventDefault();
  if (!song || song.done) return;
  const val = els.input.value.trim();
  if (!val) { showToast("Type a guess first"); return; }
  closeAC();
  if (isCorrect(val)) {
    results.push({ kind: "right", text: song.track });
    attempt++;
    endGame(true);
    return;
  }
  results.push({ kind: sameArtist(val) ? "artist" : "wrong", text: val });
  attempt++;
  els.form.classList.remove("shake");
  void els.form.offsetWidth;
  els.form.classList.add("shake");
  els.input.value = "";
  nextAttempt(650);
}

function onSkip() {
  if (!song || song.done) return;
  closeAC();
  results.push({ kind: "skipped" });
  attempt++;
  els.input.value = "";
  nextAttempt(400);
}

/* ---------- stats ---------- */
function getStats() {
  try { return JSON.parse(localStorage.getItem("songless-stats")) || { streak: 0, wins: 0, played: 0 }; }
  catch { return { streak: 0, wins: 0, played: 0 }; }
}
function bumpStats(won) {
  const s = getStats();
  s.played++;
  if (won) { s.wins++; s.streak++; } else { s.streak = 0; }
  try { localStorage.setItem("songless-stats", JSON.stringify(s)); } catch {}
  return s;
}
function renderStats(s) {
  els.statStreak.textContent = s.streak;
  els.statPlayed.textContent = s.played;
  els.statWinPct.textContent = s.played ? Math.round((s.wins / s.played) * 100) : 0;
  els.streakTop.textContent = s.streak;
  els.streakPill.hidden = s.streak < 1;
  els.howToPlay.hidden = s.played > 0;
}

/* ---------- share ---------- */
const SQUARES = { right: "🟩", artist: "🟨", wrong: "⬜", skipped: "⬛" };
function shareResult() {
  if (!song || !song.done) return;
  const grid = results.map((r) => SQUARES[r.kind]).join("");
  const score = song.solved ? `${attempt}/${SNIPPETS.length}` : `X/${SNIPPETS.length}`;
  const text = `Beatle · ${GENRES[currentGenre].label} ${score}\n${grid}`;
  const done = () => showToast("Copied to clipboard");
  if (navigator.share) navigator.share({ text }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(() => showToast("Couldn't copy"));
}

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

/* ---------- autocomplete ---------- */
let acItems = [];
let acIndex = -1;
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function highlight(text, rawQuery) {
  const i = text.toLowerCase().indexOf(rawQuery);
  if (!rawQuery || i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + rawQuery.length)) + "</mark>" + esc(text.slice(i + rawQuery.length));
}

function openAC(list, q) {
  acItems = list;
  acIndex = -1;
  els.ac.innerHTML = list.length
    ? list.map((s, i) =>
        `<button type="button" class="ac-item" role="option" id="ac-opt-${i}" aria-selected="false" data-i="${i}">
           <span class="t">${highlight(s.track, q)}</span>
           <span class="a">${highlight(s.artist, q)}</span>
         </button>`).join("")
    : `<p class="ac-empty">No matches</p>`;
  els.ac.classList.add("show");
  els.input.setAttribute("aria-expanded", "true");
}

function closeAC() {
  els.ac.classList.remove("show");
  els.ac.innerHTML = "";
  els.input.setAttribute("aria-expanded", "false");
  els.input.removeAttribute("aria-activedescendant");
  acItems = [];
  acIndex = -1;
}

function moveAC(delta) {
  const nodes = els.ac.querySelectorAll(".ac-item");
  if (!nodes.length) return;
  acIndex = (acIndex + delta + nodes.length) % nodes.length;
  nodes.forEach((n, i) => n.setAttribute("aria-selected", i === acIndex ? "true" : "false"));
  nodes[acIndex].scrollIntoView?.({ block: "nearest" });
  els.input.setAttribute("aria-activedescendant", "ac-opt-" + acIndex);
}

function chooseAC(i) {
  const s = acItems[i];
  if (!s) return;
  els.input.value = s.track;
  closeAC();
  els.input.focus();
}

function onInput() {
  const raw = els.input.value.trim();
  const q = norm(raw);
  if (q.length < 1) { closeAC(); return; }
  const lib = LIBRARY[currentGenre];
  const starts = [], contains = [];
  for (const s of lib) {
    const t = norm(s.track), a = norm(s.artist);
    if (t.startsWith(q)) starts.push(s);
    else if (t.includes(q) || a.includes(q)) contains.push(s);
    if (starts.length >= 8) break;
  }
  openAC([...starts, ...contains].slice(0, 8), raw.toLowerCase());
}

els.input.addEventListener("input", onInput);
els.input.addEventListener("focus", () => { if (els.input.value.trim()) onInput(); });
els.input.addEventListener("keydown", (e) => {
  const open = els.ac.classList.contains("show");
  if (e.key === "ArrowDown") { e.preventDefault(); open ? moveAC(1) : onInput(); }
  else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); moveAC(-1); } }
  else if (e.key === "Enter") { if (open && acIndex >= 0) { e.preventDefault(); chooseAC(acIndex); } }
  else if (e.key === "Escape") { if (open) { e.preventDefault(); closeAC(); } }
});
els.ac.addEventListener("mousedown", (e) => {
  const item = e.target.closest(".ac-item");
  if (!item) return;
  e.preventDefault();
  chooseAC(Number(item.dataset.i));
});
document.addEventListener("click", (e) => { if (!e.target.closest(".combo")) closeAC(); });

/* ---------- round ---------- */
function pickEntry() {
  const lib = LIBRARY[currentGenre];
  let src = lib.filter((s) => !recentTracks.includes(s.artist + "|" + s.track));
  if (!src.length) src = lib.slice();
  return shuffle(src.slice());
}

async function startGame() {
  if (loading) return;
  loading = true;
  const token = ++roundToken;

  stopPlayback();
  closeAC();
  els.result.classList.remove("show");
  els.input.value = "";
  attempt = 0;
  results = [];
  song = null;
  setMode("play");
  setHint(`Finding a song · ${GENRES[currentGenre].label}`);
  lockGuess(true);
  els.playBtn.disabled = true;
  document.querySelectorAll(".chip").forEach((c) => (c.disabled = true));
  renderRows();
  renderSegments();

  const candidates = pickEntry();
  let found = null;
  const cached = candidates.find((c) => previewCache.has(c.artist + "|" + c.track));
  if (cached) found = previewCache.get(cached.artist + "|" + cached.track);

  for (let i = 0; i < candidates.length && i < 8 && !found; i++) {
    try { found = await resolvePreview(candidates[i]); }
    catch { await new Promise((r) => setTimeout(r, 350)); }
    if (token !== roundToken) return;
  }

  if (token !== roundToken) return;
  loading = false;
  document.querySelectorAll(".chip").forEach((c) => (c.disabled = false));

  if (!found) {
    setHint("No response from iTunes.");
    setMode("retry");
    els.retry.focus();
    showToast("No response from iTunes, try again");
    return;
  }

  const next = candidates.find((c) => !previewCache.has(c.artist + "|" + c.track));
  if (next) setTimeout(() => { resolvePreview(next).catch(() => {}); }, 1500);

  song = Object.assign({}, found, { done: false, solved: false });
  recentTracks.push(song.artist + "|" + song.track);
  if (recentTracks.length > 25) recentTracks.shift();

  updateHint();
  renderRows();
  renderSegments();
  lockGuess(false);
  els.playBtn.disabled = false;
  if (window.matchMedia("(hover: hover)").matches) els.input.focus();
}

/* ---------- genres ---------- */
function setGenre(id) {
  if (id === currentGenre) return;
  currentGenre = id;
  document.querySelectorAll(".chip").forEach((c) => {
    const on = c.dataset.genre === id;
    c.classList.toggle("active", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
  roundToken++;
  loading = false;
  stopPlayback();
  startGame();
}
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => setGenre(c.dataset.genre)));

els.playBtn.addEventListener("click", () => { playing ? stopPlayback() : playSnippet(); });
els.form.addEventListener("submit", onSubmit);
els.skip.addEventListener("click", onSkip);
els.newSong.addEventListener("click", () => startGame());
els.newSongTop.addEventListener("click", () => { roundToken++; loading = false; startGame(); });
els.retry.addEventListener("click", () => startGame());
els.share.addEventListener("click", shareResult);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body && song && !song.done) {
    e.preventDefault();
    playing ? stopPlayback() : playSnippet();
  }
});

renderStats(getStats());
startGame();
