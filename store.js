// Accès aux données du groupe.
// Deux implémentations avec la même interface :
//  - Firebase Firestore (quand firebase-config.js est rempli) : partagé entre tous ;
//  - stockage local du navigateur (mode démo) : pour essayer sans configuration.
//
// Interface :
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

async function firebaseStore(code) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const { getFirestore, doc, collection, getDoc, setDoc, onSnapshot } = await import(`${base}/firebase-firestore.js`);
  const app = initializeApp(FIREBASE_CONFIG);
  const fs = getFirestore(app);
  const groupRef = doc(fs, "groups", code);
  const ridersRef = collection(fs, "groups", code, "riders");

  return {
    kind: "firebase",
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
    saveRider(id, data) { return setDoc(doc(ridersRef, id), data); },
  };
}

function localStore(code) {
  const key = `velotaf:demo:${code}`;
  const read = () => { try { return JSON.parse(localStorage.getItem(key)) || { group: null, riders: {} }; } catch { return { group: null, riders: {} }; } };
  const write = (v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} emit(); };
  const groupCbs = new Set(), riderCbs = new Set();
  const emit = () => { const v = read(); groupCbs.forEach((cb) => cb(v.group)); riderCbs.forEach((cb) => cb({ ...v.riders })); };
  window.addEventListener("storage", (e) => { if (e.key === key) emit(); });

  return {
    kind: "local",
    async getGroup() { return read().group; },
    async saveGroup(data) { const v = read(); v.group = data; write(v); },
    onGroup(cb) { groupCbs.add(cb); queueMicrotask(() => cb(read().group)); return () => groupCbs.delete(cb); },
    onRiders(cb) { riderCbs.add(cb); queueMicrotask(() => cb({ ...read().riders })); return () => riderCbs.delete(cb); },
    async saveRider(id, data) { const v = read(); v.riders[id] = data; write(v); },
  };
}
