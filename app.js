import { openStore, isConfigured } from "./store.js";

const $ = (id) => document.getElementById(id);
const DAYS = ["lun.", "mar.", "mer.", "jeu.", "ven."];
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

/** Prochain jour de trajet : aujourd'hui (lun-ven) tant que le retour n'est pas passé depuis 30 min, sinon le jour ouvré suivant. */
export function nextRideDay(now, retour) {
  const [h, m] = (retour || "18:00").split(":").map(Number);
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() * 60 + now.getMinutes() > h * 60 + m + 30) d = addDays(d, 1);
  while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
  return d;
}

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

function parseCode(text) {
  const s = String(text || "").trim();
  const m = s.match(/#([A-Za-z0-9]{10,40})\s*$/) || s.match(/^([A-Za-z0-9]{10,40})$/);
  return m ? m[1] : null;
}

// ---------- Mes groupes (mémorisés sur cet appareil) ----------
// La liste de tous les groupes n'est volontairement pas consultable : chaque groupe reste privé.
function myGroups() {
  let list = [];
  try { list = JSON.parse(ls.get("velotaf:groups")) || []; } catch {}
  if (!Array.isArray(list)) list = [];
  // Reprend les groupes rejoints avant l'ajout de cette liste
  try {
    for (const k of Object.keys(localStorage)) {
      const m = k.match(/^velotaf:me:([A-Za-z0-9]{10,40})$/);
      if (m && !list.some((g) => g.code === m[1])) list.push({ code: m[1], name: "", admin: false, last: 0 });
    }
  } catch {}
  return list;
}
function rememberGroup(c, patch) {
  const list = myGroups().filter((g) => g.code !== c);
  const prev = myGroups().find((g) => g.code === c) || {};
  list.push({ ...prev, code: c, ...patch, last: Date.now() });
  ls.set("velotaf:groups", JSON.stringify(list.slice(-50)));
}
function forgetGroup(c) {
  ls.set("velotaf:groups", JSON.stringify(myGroups().filter((g) => g.code !== c)));
  for (const k of ["me", "name", "firstrun"]) ls.del(`velotaf:${k}:${c}`);
  if (ls.get("velotaf:last") === c) ls.del("velotaf:last");
  renderMyGroups();
}
function renderMyGroups() {
  const list = myGroups().sort((a, b) => (b.last || 0) - (a.last || 0));
  const ul = $("mygroups"); ul.replaceChildren();
  $("mygroups-box").hidden = !list.length;
  list.forEach((g) => {
    const li = document.createElement("li"); li.className = "group-item";
    const a = document.createElement("a"); a.href = `#${g.code}`; a.className = "group-link";
    const n = document.createElement("span"); n.className = "group-name"; n.textContent = g.name || "Groupe sans nom";
    a.append(n);
    if (g.admin) { const t = document.createElement("span"); t.className = "badge"; t.textContent = "administrateur"; a.append(t); }
    if (g.me) { const m = document.createElement("span"); m.className = "hint"; m.textContent = `vous : ${g.me}`; a.append(m); }
    const del = document.createElement("button"); del.type = "button"; del.className = "ghost small"; del.textContent = "Retirer";
    del.title = "Retirer de cette liste (le groupe n'est pas supprimé)";
    del.addEventListener("click", () => {
      if (del.dataset.confirm) forgetGroup(g.code);
      else { del.dataset.confirm = "1"; del.textContent = "Confirmer ?"; setTimeout(() => { delete del.dataset.confirm; del.textContent = "Retirer"; }, 3000); }
    });
    li.append(a, del); ul.append(li);
  });
}

function show(view) {
  if (view === "view-home") renderMyGroups();
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

/** Heure de retour la plus tardive du jour (habituelle ou choisie par un cycliste). */
function latestRetour(date) {
  let latest = cfg.retour || "18:00";
  for (const id of Object.keys(riders)) { const t = timeOf(dayOf(id, date), "retour"); if (t && t !== "--:--" && t > latest) latest = t; }
  return latest;
}

function render() {
  const next = nextRideDay(new Date(), latestRetour(todayIso()));
  if (pickedDay && pickedDay <= iso(next)) pickedDay = null;
  rideDay = pickedDay ? fromIso(pickedDay) : next;
  const rd = iso(rideDay);
  $("today-h").textContent = pickedDay ? "Trajet prévu" : "Le prochain trajet";
  $("day-prev").disabled = !pickedDay;
  $("day-reset").hidden = !pickedDay;
  const ids = Object.keys(riders);

  $("today-date").textContent = (rd === todayIso() ? "Aujourd'hui, " : "") + fmtLong(rideDay);
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), "fr");
  const mine = dayOf(meId, rd) || {};

  for (const leg of ["aller", "retour"]) {
    // Cyclistes regroupés par heure de départ
    const box = $(`t-${leg}`); box.replaceChildren();
    const slots = new Map();
    ids.forEach((u) => { const t = timeOf(dayOf(u, rd), leg); if (t) { if (!slots.has(t)) slots.set(t, []); slots.get(t).push(u); } });
    const times = [...slots.keys()].sort();
    times.forEach((t) => {
      const row = document.createElement("div"); row.className = "slot";
      const tm = document.createElement("span"); tm.className = "slot-time mono"; tm.textContent = t;
      const ppl = document.createElement("div"); ppl.className = "people";
      slots.get(t).sort(byName).forEach((u) => ppl.append(chip(u)));
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

  renderWeek(ids);
  renderFeed(ids);
  renderStats(ids);
}

function renderWeek(ids) {
  const start = addDays(monday(new Date()), weekOffset * 7);
  const dates = [0, 1, 2, 3, 4].map((i) => addDays(start, i));
  const short = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  $("wk-label").textContent = `${short(dates[0])} – ${short(dates[4])}`;
  const t = $("week"); t.replaceChildren();
  const tIso = todayIso();

  const hr = t.createTHead().insertRow();
  hr.append(document.createElement("th"));
  dates.forEach((d, i) => {
    const di = iso(d), th = document.createElement("th");
    th.className = [di === tIso && "today", di === iso(rideDay) && "sel"].filter(Boolean).join(" ");
    const s = document.createElement("span"); s.className = "d"; s.textContent = d.getDate();
    if (di >= iso(nextRideDay(new Date(), latestRetour(tIso)))) {
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
          p.textContent = at && at !== cfg[leg] ? `${l} ${at}` : l;
          el.append(p); tips.push(`${word} à ${timeOf(x, leg)}`);
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

export function cycle(cur) { // — → A+R → A → R → —
  if (!cur.aller && !cur.retour) return { aller: true, retour: true };
  if (cur.aller && cur.retour) return { aller: true, retour: false };
  if (cur.aller) return { aller: false, retour: true };
  return { aller: false, retour: false };
}

for (const leg of ["aller", "retour"]) {
  $(`me-${leg}-at`).addEventListener("change", (e) => { if (e.target.value) setDay(iso(rideDay), { [`${leg}At`]: e.target.value }); });
  $(`${leg}-slots`).addEventListener("click", (e) => { const b = e.target.closest("button[data-time]"); if (b) setDay(iso(rideDay), { [`${leg}At`]: b.dataset.time }); });
}

$("week").addEventListener("click", (e) => {
  const b = e.target.closest("button.cell"); if (!b) return;
  setDay(b.dataset.date, cycle(dayOf(meId, b.dataset.date) || {}));
});
// Choix du jour réglé dans la carte du haut
function pickDay(di) { pickedDay = di; render(); }
function stepDay(n) {
  let d = addDays(rideDay, n);
  while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, n);
  pickDay(iso(d));
}
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

// Accueil
$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("create-status"); st.className = "status"; st.textContent = "Création…";
  const newCode = randomId(12);
  try {
    const s = await openStore(newCode);
    await s.saveGroup({ name: $("create-name").value.trim().slice(0, 60), meet: "", aller: "08:00", retour: "17:45", km: 0, dest: "", route: "", createdAt: Date.now(), admins: [s.uid] });
    const id = randomId(16), name = $("create-me").value.trim().slice(0, 40);
    await s.saveRider(id, { name, days: {}, posts: [], updatedAt: Date.now() });
    ls.set(`velotaf:me:${newCode}`, id); ls.set(`velotaf:name:${newCode}`, name);
    ls.set(`velotaf:firstrun:${newCode}`, "1");
    location.hash = newCode;
  } catch (err) { st.className = "status err"; st.textContent = `Création impossible : ${err?.message || err}`; }
});
$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = parseCode($("join-code").value);
  if (!c) { $("join-status").className = "status err"; $("join-status").textContent = "Lien ou code non reconnu : il se termine par # suivi d'au moins 10 lettres et chiffres."; return; }
  location.hash = c;
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
  $("share-link").textContent = `${location.origin}${location.pathname}#${code}`;
  ls.set("velotaf:last", code);
  rememberGroup(code, { name: cfg.name || "", admin: Array.isArray(cfg.admins) && cfg.admins.includes(store.uid), me: riders[id]?.name || ls.get(`velotaf:name:${code}`) || "" });
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
  code = parseCode(location.hash);
  renderConfig();
  if (!code) {
    const last = ls.get("velotaf:last");
    if (!location.hash && last) { location.replace(`#${last}`); return; }
    show("view-home"); demoBanner(); return;
  }

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
    if (!g) { clearTimeout(slow); show("view-home"); banner("Ce lien ne correspond à aucun groupe. Vérifiez qu'il est complet, ou créez un groupe.", true); return; }
    cfg = g; renderConfig();
    $("btn-config").hidden = $("view-main").hidden || !isAdmin();
    if (!isAdmin()) $("config-panel").hidden = true;
    if (meId) rememberGroup(code, { name: g.name || "", admin: Array.isArray(g.admins) && g.admins.includes(store.uid) });
    ready();
  }, onErr));
  unsubs.push(store.onRiders((r) => {
    ridersLoaded = true;
    riders = pending ? { ...r, [pending.id]: { ...(r[pending.id] || {}), ...pending.data } } : r;
    if (!$("view-who").hidden && groupLoaded) showWho();
    ready();
  }, onErr));
}

window.addEventListener("hashchange", boot);
// Chaque minute : fait disparaître les annonces de plus de 2 h et passe au jour suivant si besoin.
setInterval(() => { if (meId) render(); }, 60e3);
boot();
