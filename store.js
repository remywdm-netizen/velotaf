// Accès aux données du groupe.
// Deux implémentations avec la même interface :
//  - Firebase Firestore (quand firebase-config.js est rempli) : partagé entre tous ;
//  - stockage local du navigateur (mode démo) : pour essayer sans configuration.
//
// Interface :
//   uid                        identifiant de cet appareil (connexion anonyme Firebase)
//   getGroup()                 -> Promise<objet | null>
//   saveGroup(data)            -> Promise
//   onGroup(cb)                -> fonction de désabonnement ; cb(objet | null)
//   onRiders(cb)               -> fonction de désabonnement ; cb({ id: objet })
//   saveRider(id, data)        -> Promise

import { FIREBASE_CONFIG } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";

export const isConfigured = Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);

export async function openStore(code) {
  return isConfigured ? firebaseStore(code) : localStore(code);
}

// Firebase n'est initialisé qu'une fois par page, même si l'on change de groupe.
let firebaseReady = null;
function initFirebase() {
  if (firebaseReady) return firebaseReady;
  firebaseReady = (async () => {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const { initializeApp } = await import(`${base}/firebase-app.js`);
    const fsMod = await import(`${base}/firebase-firestore.js`);
    const { getAuth, signInAnonymously, onAuthStateChanged } = await import(`${base}/firebase-auth.js`);
    const app = initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    // Connexion anonyme : invisible pour l'utilisateur, elle donne un identifiant stable à cet appareil.
    const user = await new Promise((resolve, reject) => {
      const stop = onAuthStateChanged(auth, (u) => {
        if (u) { stop(); resolve(u); }
        else signInAnonymously(auth).catch((e) => { stop(); reject(e); });
      }, reject);
    });
    return { fs: fsMod.getFirestore(app), fsMod, uid: user.uid };
  })();
  firebaseReady.catch(() => { firebaseReady = null; });
  return firebaseReady;
}

async function firebaseStore(code) {
  const { fs, fsMod, uid } = await initFirebase();
  const { doc, collection, getDoc, setDoc, onSnapshot } = fsMod;
  const groupRef = doc(fs, "groups", code);
  const ridersRef = collection(fs, "groups", code, "riders");

  return {
    kind: "firebase",
    uid,
    async getGroup() { const s = await getDoc(groupRef); return s.exists() ? s.data() : null; },
    saveGroup(data) { return setDoc(groupRef, data); },
    onGroup(cb, onErr) { return onSnapshot(groupRef, (s) => cb(s.exists() ? s.data() : null), onErr); },
    onRiders(cb, onErr) {
      return onSnapshot(ridersRef, (snap) => {
        const out = {};
        snap.forEach((d) => { out[d.id] = d.data(); });
        cb(out);
      }, onErr);
    },
    saveRider(id, data) { return setDoc(doc(ridersRef, id), { ...data, uid }); },
  };
}

function localStore(code) {
  const key = `velotaf:demo:${code}`;
  let uid = null;
  try { uid = localStorage.getItem("velotaf:demo-uid"); } catch {}
  if (!uid) { uid = "demo" + Math.random().toString(36).slice(2, 12); try { localStorage.setItem("velotaf:demo-uid", uid); } catch {} }

  const read = () => { try { return JSON.parse(localStorage.getItem(key)) || { group: null, riders: {} }; } catch { return { group: null, riders: {} }; } };
  const write = (v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} emit(); };
  const groupCbs = new Set(), riderCbs = new Set();
  const emit = () => { const v = read(); groupCbs.forEach((cb) => cb(v.group)); riderCbs.forEach((cb) => cb({ ...v.riders })); };
  window.addEventListener("storage", (e) => { if (e.key === key) emit(); });

  return {
    kind: "local",
    uid,
    async getGroup() { return read().group; },
    async saveGroup(data) {
      // Même contrôle que les règles Firestore, pour que le mode démo se comporte pareil.
      const v = read(), admins = v.group && v.group.admins;
      if (v.group && admins && !admins.includes(uid)) throw new Error("seuls les administrateurs peuvent modifier les réglages");
      v.group = data; write(v);
    },
    onGroup(cb) { groupCbs.add(cb); queueMicrotask(() => cb(read().group)); return () => groupCbs.delete(cb); },
    onRiders(cb) { riderCbs.add(cb); queueMicrotask(() => cb({ ...read().riders })); return () => riderCbs.delete(cb); },
    async saveRider(id, data) { const v = read(); v.riders[id] = { ...data, uid }; write(v); },
  };
}

// ---------- Annuaire des groupes publics ----------
// Un groupe n'y figure que si l'un de ses administrateurs l'a rendu public.
// Interface : list() -> Promise<[{ code, name, meet, dest, aller, retour, km }]>,
//             publish(code, entry) -> Promise, unpublish(code) -> Promise
export async function openDirectory() {
  if (isConfigured) {
    const { fs, fsMod } = await initFirebase();
    const { collection, doc, getDocs, setDoc, deleteDoc } = fsMod;
    const col = collection(fs, "directory");
    return {
      async list() { const snap = await getDocs(col); const out = []; snap.forEach((d) => out.push({ ...d.data(), code: d.id })); return out; },
      publish(code, entry) { return setDoc(doc(col, code), entry); },
      unpublish(code) { return deleteDoc(doc(col, code)); },
    };
  }
  const key = "velotaf:demo:directory";
  const read = () => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
  const write = (v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
  return {
    async list() { return Object.entries(read()).map(([code, e]) => ({ ...e, code })); },
    async publish(code, entry) { const v = read(); v[code] = entry; write(v); },
    async unpublish(code) { const v = read(); delete v[code]; write(v); },
  };
}
