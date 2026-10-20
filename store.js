/* Data layer. Same API for both modes:
   - shared (Firebase configured): groups/{code}/{people|hikes|stamps|photos}, anonymous auth,
     offline cache so writes made on the mountain sync later.
   - local: IndexedDB on this phone only. */
import { FIREBASE } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/11.10.0/";
export const shared = !!FIREBASE.apiKey;
const WATCHED = ["people", "hikes", "stamps"];

let fs = null, db = null, uid = null;
let gid = localStorage.getItem("gs-group") || "";
const clean = (o) => JSON.parse(JSON.stringify(o));

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const groupId = () => gid;

/* ---------- local (IndexedDB) ---------- */
let idb = null;
const local = {};               // col -> Map(id -> doc)
const listeners = {};           // col -> Set(cb)
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("gachisan", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbReq(mode, fn) {
  return new Promise((res, rej) => {
    const tx = idb.transaction("kv", mode), st = tx.objectStore("kv"), r = fn(st);
    tx.oncomplete = () => res(r && r.result);
    tx.onerror = () => rej(tx.error);
  });
}
async function localLoad() {
  idb = await idbOpen();
  const keys = await idbReq("readonly", (st) => st.getAllKeys());
  const vals = await idbReq("readonly", (st) => st.getAll());
  keys.forEach((k, i) => {
    const [col, id] = k.split("/");
    (local[col] ||= new Map()).set(id, vals[i]);
  });
}
const localList = (col) => [...(local[col] || new Map()).values()];
const emit = (col) => (listeners[col] || []).forEach((cb) => cb(localList(col)));

/* ---------- init / groups ---------- */
export async function init() {
  if (!shared) { await localLoad(); return { mode: "local" }; }
  const [{ initializeApp }, auth, f] = await Promise.all([
    import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js"),
  ]);
  fs = f;
  const app = initializeApp(FIREBASE);
  db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  const a = auth.getAuth(app);
  if (FIREBASE.emulator) {   // local testing only
    auth.connectAuthEmulator(a, "http://127.0.0.1:9099", { disableWarnings: true });
    fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  uid = await new Promise((res, rej) => {
    const off = auth.onAuthStateChanged(a, (u) => {
      if (u) { off(); res(u.uid); } else auth.signInAnonymously(a).catch(rej);
    });
  });
  if (gid && !(await groupExists(gid, true))) setGroup("");
  return { mode: "shared", uid };
}

function setGroup(code) {
  gid = code;
  if (code) localStorage.setItem("gs-group", code); else localStorage.removeItem("gs-group");
}

/* fromCache: trust the offline cache so the app still opens on the mountain. */
async function groupExists(code, fromCache) {
  const ref = fs.doc(db, "groups", code);
  try {
    const s = fromCache ? await fs.getDoc(ref).catch(() => fs.getDocFromCache(ref)) : await fs.getDocFromServer(ref);
    return s.exists();
  } catch { return fromCache; }
}

export async function groupInfo() {
  if (!shared || !gid) return { name: "우리 가족" };
  const s = await fs.getDoc(fs.doc(db, "groups", gid)).catch(() => null);
  return s && s.exists() ? s.data() : { name: "우리 가족" };
}

export async function renameGroup(name) {
  await fs.setDoc(fs.doc(db, "groups", gid), { name }, { merge: true });
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function createGroup(name) {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  await fs.setDoc(fs.doc(db, "groups", code), { name, createdAt: Date.now() });
  await fs.setDoc(fs.doc(db, "groups", code, "devices", uid), { at: Date.now(), ua: navigator.userAgent.slice(0, 120) });
  setGroup(code);
  return code;
}

export async function joinGroup(code) {
  code = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8 || !(await groupExists(code, false))) return false;
  await fs.setDoc(fs.doc(db, "groups", code, "devices", uid), { at: Date.now(), ua: navigator.userAgent.slice(0, 120) });
  setGroup(code);
  return true;
}

export function leaveGroup() { setGroup(""); }

/* ---------- documents ---------- */
const colRef = (col) => fs.collection(db, "groups", gid, col);

export function watch(col, cb) {
  if (!shared) {
    (listeners[col] ||= new Set()).add(cb);
    cb(localList(col));
    return () => listeners[col].delete(cb);
  }
  return fs.onSnapshot(colRef(col), (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
    (e) => console.warn("watch", col, e));
}

export async function put(col, id, data) {
  data = clean({ ...data, id });
  if (!shared) {
    (local[col] ||= new Map()).set(id, data);
    await idbReq("readwrite", (st) => st.put(data, col + "/" + id));
    if (WATCHED.includes(col)) emit(col);
    return;
  }
  // Offline: the write is queued in the cache; don't block the UI waiting for the server.
  const p = fs.setDoc(fs.doc(colRef(col), id), data);
  if (navigator.onLine) await p; else p.catch((e) => console.warn("put", e));
}

export async function del(col, id) {
  if (!shared) {
    local[col]?.delete(id);
    await idbReq("readwrite", (st) => st.delete(col + "/" + id));
    if (WATCHED.includes(col)) emit(col);
    return;
  }
  const p = fs.deleteDoc(fs.doc(colRef(col), id));
  if (navigator.onLine) await p; else p.catch((e) => console.warn("del", e));
}

export async function photosOf(hikeId) {
  if (!shared) return localList("photos").filter((p) => p.hike === hikeId).sort((a, b) => a.t - b.t);
  const snap = await fs.getDocs(fs.query(colRef("photos"), fs.where("hike", "==", hikeId)));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.t - b.t);
}
