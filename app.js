import { openStore, isConfigured } from "./store.js";
import { GROUP_CODE } from "./groupe.js";

const $ = (id) => document.getElementById(id);
const DAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Durée de vie d'une annonce : 2 heures. */
const POST_TTL = 2 * 3600e3;
const pad = (n) => String(n).padStart(2, "0");

// ---------- Dates ----------
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const fmtLong = (d) => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

/** Premier jour encore modifiable : aujourd'hui tant que le retour n'est pas passé depuis 30 min, sinon demain. */
export function firstOpenDay(now, retour) {
  const [h, m] = (retour || "18:00").split(":").map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m + 30 ? addDays(d, 1) : d;
}

/** Prochain trajet : le premier jour ouvré à venir, ou un samedi/dimanche si quelqu'un y est inscrit. */
export function nextRideDay(now, retour, hasRiders = () => false) {
  let d = firstOpenDay(now, retour);
  while ((d.getDay() === 0 || d.getDay() === 6) && !hasRiders(iso(d))) d = addDays(d, 1);
  return d;
}
const someoneRides = (date) => Object.keys(riders).some((u) => { const x = dayOf(u, date); return x && (x.aller || x.retour); });

function randomId(n) {
  const bytes = new Uint8Array(n); crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// ---------- Stockage local (préférences de cet appareil) ----------
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- Avatars (initiales sur une couleur dérivée du nom) ----------
function avatar(name) {
  const el = document.createElement("span"); el.className = "av"; el.setAttribute("aria-hidden", "true");
  const n = (name || "?").trim();
  let h = 0; for (const c of n) h = (h * 31 + c.codePointAt(0)) >>> 0;
  el.style.background = `hsl(${h % 360} 45% 40%)`;
  el.textContent = n.split(/\s+/).map((p) => p[0] || "").join("").slice(0, 2).toUpperCase();
  return el;
}

// ---------- État ----------
let store = null, code = null, meId = null;
let cfg = {}, riders = {}, weekOffset = 0, rideDay = new Date();
let pickedDay = null; // jour futur choisi par l'utilisateur (AAAA-MM-JJ), sinon le prochain trajet
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
let groupLoaded = false, ridersLoaded = false;

function show(view) {
  for (const v of ["view-home", "view-who", "view-main"]) $(v).hidden = v !== view;
  $("facts").hidden = view === "view-home";
  $("btn-config").hidden = view !== "view-main" || !isAdmin();
}

function banner(msg, err) {
  const b = $("banner");
  if (!msg) { b.hidden = true; return; }
  b.hidden = false; b.className = "banner" + (err ? " err" : "");
  b.replaceChildren();
  if (typeof msg === "string") b.textContent = msg; else b.append(msg);
}

function demoBanner() {
  if (isConfigured) return;
  const s = document.createElement("span");
  const st = document.createElement("strong"); st.textContent = "Mode démo : ";
  s.append(st, "les données restent dans ce navigateur. Pour partager le planning avec le groupe, renseignez firebase-config.js (voir le README).");
  banner(s);
}

// ---------- Rendu ----------
function renderConfig() {
  $("g-name").textContent = cfg.name || "Vélotaf";
  document.title = cfg.name ? (cfg.name === "Vélotaf" ? "Vélotaf" : `${cfg.name} · Vélotaf`) : "Vélotaf";
  $("g-meet").textContent = cfg.meet || "À définir";
  $("g-aller").textContent = cfg.aller || "--:--";
  $("g-retour").textContent = cfg.retour || "--:--";
  $("g-dest").textContent = cfg.dest || "À définir";
  $("g-km").textContent = cfg.km ? `${String(cfg.km).replace(".", ",")} km` : "— km";
  $("t-aller-time").textContent = cfg.aller || "--:--";
  $("t-retour-time").textContent = cfg.retour || "--:--";
  $("route-panel").hidden = !cfg.route;
  $("route-text").textContent = cfg.route || "";
}

const nameOf = (id) => (id === meId ? "Moi" : (riders[id] && riders[id].name) || "Cycliste");
const dayOf = (id, date) => (riders[id] && riders[id].days && riders[id].days[date]) || null;

function chip(id) {
  const el = document.createElement("span"); el.className = "chip";
  const s = document.createElement("span"); s.textContent = nameOf(id);
  el.append(avatar(riders[id] && riders[id].name), s);
  return el;
}

/** Heure de départ d'un cycliste pour un trajet ("aller" ou "retour"), ou null s'il ne le fait pas. */
const timeOf = (x, leg) => (x && x[leg] ? x[`${leg}At`] || cfg[leg] || "--:--" : null);
/** Point de départ du matin d'un cycliste : le sien s'il l'a changé, sinon le rendez-vous du groupe. */
const placeOf = (x) => (x && x.aller ? x.allerFrom || cfg.meet || "" : null);

/** Heure de retour la plus tardive du jour (habituelle ou choisie par un cycliste). */
function latestRetour(date) {
  let latest = cfg.retour || "18:00";
  for (const id of Object.keys(riders)) { const t = timeOf(dayOf(id, date), "retour"); if (t && t !== "--:--" && t > latest) latest = t; }
  return latest;
}

function render() {
  const first = iso(firstOpenDay(new Date(), latestRetour(todayIso())));
  const next = nextRideDay(new Date(), latestRetour(todayIso()), someoneRides);
  if (pickedDay && (pickedDay < first || pickedDay === iso(next))) pickedDay = null;
  rideDay = pickedDay ? fromIso(pickedDay) : next;
  const rd = iso(rideDay);
  $("today-h").textContent = pickedDay ? "Trajet prévu" : "Le prochain trajet";
  $("day-prev").disabled = rd <= first;
  $("day-reset").hidden = !pickedDay;
  const ids = Object.keys(riders);

  $("today-date").textContent = (rd === todayIso() ? "Aujourd'hui, " : "") + fmtLong(rideDay);
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), "fr");
  const mine = dayOf(meId, rd) || {};

  for (const leg of ["aller", "retour"]) {
    // Cyclistes regroupés par heure (et, le matin, par point de départ)
    const box = $(`t-${leg}`); box.replaceChildren();
    const slots = new Map(), groups = new Map();
    ids.forEach((u) => {
      const x = dayOf(u, rd), t = timeOf(x, leg); if (!t) return;
      if (!slots.has(t)) slots.set(t, []); slots.get(t).push(u);
      const place = leg === "aller" ? placeOf(x) : "";
      const key = `${t}|${place}`;
      if (!groups.has(key)) groups.set(key, { t, place, ids: [] }); groups.get(key).ids.push(u);
    });
    const times = [...slots.keys()].sort();
    const multiPlaces = new Set([...groups.values()].map((g) => g.place)).size > 1;
    [...groups.values()].sort((a, b) => a.t.localeCompare(b.t) || a.place.localeCompare(b.place, "fr")).forEach((g) => {
      const row = document.createElement("div"); row.className = "slot";
      const tm = document.createElement("span"); tm.className = "slot-time mono"; tm.textContent = g.t;
      const ppl = document.createElement("div"); ppl.className = "people";
      if (g.place && (g.place !== cfg.meet || multiPlaces)) { const pl = document.createElement("span"); pl.className = "slot-place"; pl.textContent = `depuis ${g.place}`; ppl.append(pl); }
      g.ids.sort(byName).forEach((u) => ppl.append(chip(u)));
      row.append(tm, ppl); box.append(row);
    });
    if (!times.length) { const e = document.createElement("span"); e.className = "empty"; e.textContent = "Personne d'inscrit pour l'instant."; box.append(e); }
    $(`t-${leg}-n`).textContent = [...slots.values()].reduce((n, l) => n + l.length, 0);
    $(`t-${leg}-time`).textContent = times.length > 1 ? `${times[0]} → ${times[times.length - 1]}` : (times[0] || cfg[leg] || "--:--");

    // Mon bouton, mon heure, et raccourcis vers les heures déjà choisies par d'autres
    $(`me-${leg}`).setAttribute("aria-pressed", mine[leg] ? "true" : "false");
    $(`me-${leg}-wrap`).hidden = !mine[leg];
    if (mine[leg]) {
      const myT = timeOf(mine, leg), input = $(`me-${leg}-at`);
      if (document.activeElement !== input) input.value = myT === "--:--" ? "" : myT;
      const sl = $(`${leg}-slots`); sl.replaceChildren();
      const others = new Set([cfg[leg], ...times].filter((t) => t && t !== "--:--" && t !== myT));
      [...others].sort().forEach((t) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "slot-btn mono"; b.dataset.time = t;
        const n = (slots.get(t) || []).length;
        b.textContent = n ? `${t} · ${n}` : t;
        b.title = n ? `Partir à ${t} avec ${n} cycliste${n > 1 ? "s" : ""}` : `Partir à ${t} (heure habituelle)`;
        sl.append(b);
      });
    }
  }

  // Mon point de départ du matin + raccourcis vers les points déjà choisis par d'autres
  if (mine.aller) {
    const myP = placeOf(mine), input = $("me-aller-from");
    if (document.activeElement !== input) input.value = myP;
    input.placeholder = cfg.meet || "Point de rendez-vous";
    const counts = new Map();
    ids.forEach((u) => { const p = placeOf(dayOf(u, rd)); if (p) counts.set(p, (counts.get(p) || 0) + 1); });
    const pl = $("aller-places"); pl.replaceChildren();
    [...new Set([cfg.meet, ...counts.keys()])].filter((p) => p && p !== myP).sort((a, b) => a.localeCompare(b, "fr")).forEach((p) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "slot-btn"; b.dataset.place = p;
      const n = counts.get(p) || 0;
      b.textContent = n ? `${p} · ${n}` : p;
      b.title = p === cfg.meet ? "Point de rendez-vous habituel du groupe" : `Partir de ${p}`;
      pl.append(b);
    });
  }

  renderWeek(ids);
  renderEditor();
  renderFeed(ids);
  renderStats(ids);
}

function renderWeek(ids) {
  const start = addDays(monday(new Date()), weekOffset * 7);
  const dates = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  const short = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  $("wk-label").textContent = `${short(dates[0])} – ${short(dates[6])}`;
  const t = $("week"); t.replaceChildren();
  const tIso = todayIso();

  const hr = t.createTHead().insertRow();
  hr.append(document.createElement("th"));
  dates.forEach((d, i) => {
    const di = iso(d), th = document.createElement("th");
    th.className = [di === tIso && "today", di === iso(rideDay) && "sel", i >= 5 && "we"].filter(Boolean).join(" ");
    const s = document.createElement("span"); s.className = "d"; s.textContent = d.getDate();
    if (di >= iso(firstOpenDay(new Date(), latestRetour(tIso)))) {
      // Jour à venir : un clic l'ouvre dans la carte du haut pour régler ses horaires
      const b = document.createElement("button"); b.type = "button"; b.className = "daybtn"; b.dataset.day = di;
      b.setAttribute("aria-label", `Régler mes horaires du ${fmtLong(d)}`);
      b.append(DAYS[i], s); th.append(b);
    } else th.append(DAYS[i], s);
    hr.append(th);
  });

  const tb = t.createTBody();
  const order = ids.slice().sort((a, b) => (a === meId ? -1 : b === meId ? 1 : nameOf(a).localeCompare(nameOf(b), "fr")));
  const shown = order.filter((u) => u === meId || dates.some((d) => { const x = dayOf(u, iso(d)); return x && (x.aller || x.retour); }));
  if (meId && !shown.includes(meId)) shown.unshift(meId);
  shown.forEach((u) => {
    const r = tb.insertRow(); if (u === meId) r.className = "mine";
    const c0 = r.insertCell(); c0.className = "who";
    c0.append(avatar(riders[u]?.name || ls.get(`velotaf:name:${code}`)), document.createTextNode(nameOf(u)));
    dates.forEach((d) => {
      const di = iso(d), x = dayOf(u, di) || {}, past = di < tIso;
      const el = document.createElement(u === meId && !past ? "button" : "div");
      el.className = "cell" + (past ? " past" : "");
      if (el.tagName === "BUTTON") { el.type = "button"; el.dataset.date = di; el.setAttribute("aria-label", `Mon trajet du ${fmtLong(d)}`); }
      if (x.aller || x.retour) {
        const tips = [];
        for (const [leg, l, word] of [["aller", "A", "Aller"], ["retour", "R", "Retour"]]) if (x[leg]) {
          const at = x[`${leg}At`], p = document.createElement("span"); p.className = "pip";
          const moved = leg === "aller" && x.allerFrom && x.allerFrom !== cfg.meet;
          p.textContent = (at && at !== cfg[leg] ? `${l} ${at}` : l) + (moved ? " •" : "");
          el.append(p); tips.push(`${word} à ${timeOf(x, leg)}${moved ? ` depuis ${x.allerFrom}` : ""}`);
        }
        el.title = tips.join(" · ");
      } else el.textContent = "—";
      r.insertCell().append(el);
    });
  });

  const fr = t.createTFoot().insertRow(); fr.insertCell();
  dates.forEach((d) => {
    const di = iso(d); let a = 0, rr = 0;
    ids.forEach((u) => { const x = dayOf(u, di); if (x?.aller) a++; if (x?.retour) rr++; });
    const c = fr.insertCell(); c.textContent = `${a}↗ ${rr}↙`; c.title = `${a} à l'aller, ${rr} au retour`;
  });
}

function renderFeed(ids) {
  const since = Date.now() - POST_TTL;
  const all = [];
  ids.forEach((u) => (riders[u]?.posts || []).forEach((p) => { if (p && p.t > since) all.push({ ...p, u }); }));
  all.sort((a, b) => b.t - a.t);
  const ul = $("feed"); ul.replaceChildren();
  if (!all.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Pas d'annonce. Prévenez ici en cas de retard ou d'absence."; ul.append(li); return; }
  all.slice(0, 30).forEach((p) => {
    const li = document.createElement("li"); li.className = "post" + (p.alert ? " alert" : "");
    const body = document.createElement("div");
    const meta = document.createElement("div"); meta.className = "meta";
    const w = new Date(p.t);
    meta.textContent = `${nameOf(p.u)} · ${iso(w) === todayIso() ? "" : w.toLocaleDateString("fr-FR", { weekday: "short" }) + " "}${pad(w.getHours())}:${pad(w.getMinutes())}`;
    const txt = document.createElement("div"); txt.className = "txt"; txt.textContent = String(p.text || "");
    body.append(meta, txt); li.append(avatar(riders[p.u]?.name), body); ul.append(li);
  });
}

export function monthTrips(ridersMap, now) {
  const prefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-`, t = iso(now);
  let trips = 0;
  for (const r of Object.values(ridersMap)) for (const [k, v] of Object.entries(r.days || {})) {
    if (k.startsWith(prefix) && k <= t) { if (v.aller) trips++; if (v.retour) trips++; }
  }
  return trips;
}

function renderStats() {
  const trips = monthTrips(riders, new Date());
  const km = trips * (Number(cfg.km) || 0);
  $("s-trips").textContent = trips;
  $("s-km").textContent = Math.round(km).toLocaleString("fr-FR");
  $("s-co2").textContent = `${Math.round(km * 0.2).toLocaleString("fr-FR")} kg`;
}

// ---------- Écriture de mon document (une écriture à la fois) ----------
let pending = null, writing = false, timer = null;

function myDoc() {
  const cur = riders[meId] || {};
  return { name: cur.name || ls.get(`velotaf:name:${code}`) || "Cycliste", days: { ...(cur.days || {}) }, posts: (cur.posts || []).slice() };
}

export function prune(d, now = new Date()) {
  const cutoff = iso(addDays(now, -62));
  for (const k of Object.keys(d.days)) { const v = d.days[k]; if (k < cutoff || !v || (!v.aller && !v.retour)) delete d.days[k]; }
  const since = now.getTime() - POST_TTL;
  d.posts = d.posts.filter((p) => p.t > since).slice(-20);
  return d;
}

function stage(d, immediate) {
  d = prune(d);
  riders = { ...riders, [meId]: { ...d, updatedAt: Date.now() } };
  pending = { id: meId, data: d }; render();
  clearTimeout(timer); timer = setTimeout(flush, immediate ? 0 : 500);
}

async function flush() {
  if (writing || !pending) return;
  writing = true;
  const { id, data } = pending; pending = null;
  try { await store.saveRider(id, { ...data, updatedAt: Date.now() }); if (isConfigured) banner(null); }
  catch (e) { banner(`Enregistrement impossible : ${e?.message || e}. Vérifiez votre connexion.`, true); }
  writing = false;
  if (pending) flush();
}

function setDay(date, patch) {
  const d = myDoc(); const prev = d.days[date] || {};
  const next = { aller: !!(patch.aller ?? prev.aller), retour: !!(patch.retour ?? prev.retour) };
  for (const leg of ["aller", "retour"]) {
    const k = `${leg}At`, at = k in patch ? patch[k] : prev[k];
    if (next[leg] && at && /^\d\d:\d\d$/.test(at) && at !== cfg[leg]) next[k] = at;
  }
  const from = String(("allerFrom" in patch ? patch.allerFrom : prev.allerFrom) || "").trim().slice(0, 100);
  if (next.aller && from && from !== cfg.meet) next.allerFrom = from;
  d.days[date] = next; stage(d);
}

function post(text, alert) {
  text = String(text || "").trim().slice(0, 200);
  if (!text) return;
  const d = myDoc(); d.posts.push({ t: Date.now(), text, alert: !!alert }); stage(d, true);
}

// ---------- Événements ----------
for (const k of ["aller", "retour"]) {
  $(`me-${k}`).addEventListener("click", () => {
    const rd = iso(rideDay), cur = dayOf(meId, rd) || {};
    setDay(rd, { [k]: !cur[k] });
  });
}

for (const leg of ["aller", "retour"]) {
  $(`me-${leg}-at`).addEventListener("change", (e) => { if (e.target.value) setDay(iso(rideDay), { [`${leg}At`]: e.target.value }); });
  $(`${leg}-slots`).addEventListener("click", (e) => { const b = e.target.closest("button[data-time]"); if (b) setDay(iso(rideDay), { [`${leg}At`]: b.dataset.time }); });
}

$("me-aller-from").addEventListener("change", (e) => setDay(iso(rideDay), { allerFrom: e.target.value }));
$("aller-places").addEventListener("click", (e) => { const b = e.target.closest("button[data-place]"); if (b) setDay(iso(rideDay), { allerFrom: b.dataset.place }); });

// Éditeur d'un jour, ouvert en touchant une de mes cases dans la grille
let editDay = null;
function renderEditor() {
  const ed = $("day-editor");
  if (!editDay || editDay < todayIso()) { ed.hidden = true; editDay = null; return; }
  ed.hidden = false;
  const x = dayOf(meId, editDay) || {};
  $("ed-title").textContent = fmtLong(fromIso(editDay)).replace(/^./, (c) => c.toUpperCase());
  for (const leg of ["aller", "retour"]) {
    $(`ed-${leg}`).setAttribute("aria-pressed", x[leg] ? "true" : "false");
    $(`ed-${leg}-f`).hidden = !x[leg];
    const inp = $(`ed-${leg}-at`);
    if (document.activeElement !== inp) inp.value = x[leg] ? x[`${leg}At`] || cfg[leg] || "" : "";
  }
  $("ed-from-f").hidden = !x.aller;
  $("ed-from").placeholder = cfg.meet || "Point de rendez-vous";
  if (document.activeElement !== $("ed-from")) $("ed-from").value = x.aller ? x.allerFrom || cfg.meet || "" : "";
  document.querySelectorAll("#week button.cell").forEach((c) => c.classList.toggle("editing", c.dataset.date === editDay));
}
$("week").addEventListener("click", (e) => {
  const b = e.target.closest("button.cell"); if (!b) return;
  editDay = editDay === b.dataset.date ? null : b.dataset.date;
  // Un jour vide s'ouvre avec l'aller et le retour cochés, à modifier ensuite
  if (editDay) { const x = dayOf(meId, editDay); if (!x || (!x.aller && !x.retour)) setDay(editDay, { aller: true, retour: true }); }
  renderEditor();
});
$("ed-close").addEventListener("click", () => { editDay = null; renderEditor(); });
for (const leg of ["aller", "retour"]) {
  $(`ed-${leg}`).addEventListener("click", () => { const x = dayOf(meId, editDay) || {}; setDay(editDay, { [leg]: !x[leg] }); });
  $(`ed-${leg}-at`).addEventListener("change", (e) => { if (e.target.value) setDay(editDay, { [`${leg}At`]: e.target.value }); });
}
$("ed-from").addEventListener("change", (e) => setDay(editDay, { allerFrom: e.target.value }));
// Choix du jour réglé dans la carte du haut
function pickDay(di) { pickedDay = di; render(); }
function stepDay(n) { pickDay(iso(addDays(rideDay, n))); }
$("day-prev").addEventListener("click", () => stepDay(-1));
$("day-next").addEventListener("click", () => stepDay(1));
$("day-reset").addEventListener("click", () => pickDay(null));
$("week").addEventListener("click", (e) => {
  const b = e.target.closest("button.daybtn"); if (!b) return;
  pickDay(b.dataset.day);
  $("today-h").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
});
$("wk-prev").addEventListener("click", () => { weekOffset--; render(); });
$("wk-next").addEventListener("click", () => { weekOffset++; render(); });

$("post-form").addEventListener("submit", (e) => { e.preventDefault(); post($("post-text").value); $("post-text").value = ""; });
$("quick").addEventListener("click", (e) => { const b = e.target.closest("button[data-msg]"); if (b) post(b.dataset.msg, b.dataset.alert); });

$("btn-copy").addEventListener("click", async () => {
  const link = $("share-link").textContent;
  try { await navigator.clipboard.writeText(link); $("btn-copy").textContent = "Copié"; }
  catch { const r = document.createRange(); r.selectNodeContents($("share-link")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("btn-copy").textContent = "Sélectionné"; }
  setTimeout(() => { $("btn-copy").textContent = "Copier"; }, 1800);
});
$("btn-switch").addEventListener("click", () => { clearTimeout(timer); flush(); ls.del(`velotaf:me:${code}`); meId = null; showWho(); });

// Réglages (réservés aux administrateurs ; les règles Firestore le vérifient aussi)
/** Un groupe sans liste d'administrateurs (créé avant cette fonction) reste modifiable par tous. */
function isAdmin() { return !!store && (!Array.isArray(cfg.admins) || cfg.admins.includes(store.uid)); }

function renderAdmins() {
  const box = $("cfg-admins"); box.replaceChildren();
  const admins = new Set(Array.isArray(cfg.admins) ? cfg.admins : [store.uid]);
  const seen = new Set();
  Object.entries(riders).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "fr")).forEach(([id, r]) => {
    if (!r.uid || seen.has(r.uid)) return; seen.add(r.uid);
    const lab = document.createElement("label"); lab.className = "admin-opt";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = r.uid; cb.checked = admins.has(r.uid);
    if (r.uid === store.uid) { cb.checked = true; cb.disabled = true; }
    const s = document.createElement("span"); s.textContent = r.uid === store.uid ? `${r.name || "Moi"} (vous)` : (r.name || "Cycliste");
    lab.append(cb, avatar(r.name), s); box.append(lab);
  });
}

function openConfig() {
  if (!isAdmin()) return;
  renderAdmins();
  $("cfg-name").value = cfg.name || ""; $("cfg-meet").value = cfg.meet || "";
  $("cfg-aller").value = cfg.aller || "08:00"; $("cfg-retour").value = cfg.retour || "17:45";
  $("cfg-km").value = cfg.km || ""; $("cfg-dest").value = cfg.dest || ""; $("cfg-route").value = cfg.route || "";
  $("cfg-status").textContent = ""; $("config-panel").hidden = false; $("cfg-meet").focus();
}
$("btn-config").addEventListener("click", openConfig);
$("cfg-cancel").addEventListener("click", () => { $("config-panel").hidden = true; });
$("cfg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {
    name: $("cfg-name").value.trim() || "Vélotaf", meet: $("cfg-meet").value.trim(),
    aller: $("cfg-aller").value, retour: $("cfg-retour").value,
    km: Math.min(200, Math.max(0, Number($("cfg-km").value) || 0)),
    dest: $("cfg-dest").value.trim(), route: $("cfg-route").value.trim(), createdAt: cfg.createdAt || Date.now(),
    admins: [...new Set([store.uid, ...[...$("cfg-admins").querySelectorAll("input:checked")].map((c) => c.value)])].slice(0, 10),
  };
  const st = $("cfg-status"); st.className = "status"; st.textContent = "Enregistrement…";
  try { await store.saveGroup(data); st.textContent = "Enregistré."; setTimeout(() => { $("config-panel").hidden = true; }, 700); }
  catch (err) { st.className = "status err"; st.textContent = `Refusé : seuls les administrateurs du groupe peuvent modifier les réglages.`; console.error(err); }
});

// Mise en place du groupe (une seule fois, par la première personne : elle en devient administratrice)
$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("create-status"); st.className = "status"; st.textContent = "Création…";
  const newCode = GROUP_CODE;
  try {
    const s = await openStore(newCode);
    await s.saveGroup({ name: $("create-name").value.trim().slice(0, 60), meet: "", aller: "08:00", retour: "17:45", km: 0, dest: "", route: "", createdAt: Date.now(), admins: [s.uid] });
    const id = randomId(16), name = $("create-me").value.trim().slice(0, 40);
    await s.saveRider(id, { name, days: {}, posts: [], updatedAt: Date.now() });
    ls.set(`velotaf:me:${newCode}`, id); ls.set(`velotaf:name:${newCode}`, name);
    ls.set(`velotaf:firstrun:${newCode}`, "1");
    boot();
  } catch (err) { st.className = "status err"; st.textContent = `Création impossible : ${err?.message || err}`; }
});
// Identité
function showWho() {
  show("view-who");
  const list = $("who-list"); list.replaceChildren();
  Object.keys(riders).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "fr")).forEach((id) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    const s = document.createElement("span"); s.textContent = riders[id].name || "Cycliste";
    b.append(avatar(riders[id].name), s);
    b.addEventListener("click", () => { ls.set(`velotaf:me:${code}`, id); ls.set(`velotaf:name:${code}`, riders[id].name || ""); enterMain(id); });
    list.append(b);
  });
  if (!list.children.length) { const e = document.createElement("span"); e.className = "empty"; e.textContent = "Personne dans le groupe pour l'instant. Ajoutez votre prénom."; list.append(e); }
}
$("who-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("who-name").value.trim().slice(0, 40); if (!name) return;
  const id = randomId(16);
  try {
    await store.saveRider(id, { name, days: {}, posts: [], updatedAt: Date.now() });
    ls.set(`velotaf:me:${code}`, id); ls.set(`velotaf:name:${code}`, name);
    enterMain(id);
  } catch (err) { $("who-status").className = "status err"; $("who-status").textContent = `Inscription impossible : ${err?.message || err}`; }
});

function enterMain(id) {
  meId = id;
  $("me-name").textContent = riders[id]?.name || ls.get(`velotaf:name:${code}`) || "";
  $("share-link").textContent = `${location.origin}${location.pathname}`;
  show("view-main");
  render();
  if (ls.get(`velotaf:firstrun:${code}`)) { ls.del(`velotaf:firstrun:${code}`); openConfig(); }
}

// ---------- Démarrage ----------
let unsubs = [];
async function boot() {
  unsubs.forEach((u) => u()); unsubs = [];
  $("config-panel").hidden = true;
  cfg = {}; riders = {}; groupLoaded = ridersLoaded = false; meId = null;
  code = GROUP_CODE;
  renderConfig();
  if (location.hash) history.replaceState(null, "", location.pathname);

  banner("Chargement du groupe…");
  try { store = await openStore(code); }
  catch (err) { banner(`Impossible de joindre la base de données : ${err?.message || err}`, true); return; }

  const slow = setTimeout(() => { if (!groupLoaded) banner("Le groupe ne répond pas encore. Vérifiez votre connexion.", true); }, 10000);
  const onErr = (err) => { clearTimeout(slow); banner(`Accès refusé ou lien invalide (${err?.code || err?.message || err}).`, true); };

  const ready = () => {
    if (!groupLoaded || !ridersLoaded) return;
    clearTimeout(slow);
    if (isConfigured) banner(null); else demoBanner();
    if (meId) { render(); return; }
    const saved = ls.get(`velotaf:me:${code}`);
    if (saved && riders[saved]) enterMain(saved);
    else if (!$("view-who").hidden) showWho();
    else showWho();
  };

  unsubs.push(store.onGroup((g) => {
    groupLoaded = true;
    if (!g) { groupLoaded = false; clearTimeout(slow); show("view-home"); if (isConfigured) banner(null); else demoBanner(); return; }
    cfg = g; renderConfig();
    $("btn-config").hidden = $("view-main").hidden || !isAdmin();
    if (!isAdmin()) $("config-panel").hidden = true;
    ready();
  }, onErr));
  unsubs.push(store.onRiders((r) => {
    ridersLoaded = true;
    riders = pending ? { ...r, [pending.id]: { ...(r[pending.id] || {}), ...pending.data } } : r;
    if (!$("view-who").hidden && groupLoaded) showWho();
    ready();
  }, onErr));
}

// Chaque minute : fait disparaître les annonces de plus de 2 h et passe au jour suivant si besoin.
setInterval(() => { if (meId) render(); }, 60e3);
boot();
