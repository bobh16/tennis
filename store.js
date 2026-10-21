// Court Sense — durable on-device storage (IndexedDB).
// Holds the full member roster plus app state, so everything survives offline,
// across restarts, and scales to thousands of members.

const DB_NAME = "courtsense";
const DB_VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("players")) db.createObjectStore("players", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror = e => rej(e.target.error);
  });
}

function getAll(db, storeName) {
  return new Promise((res, rej) => {
    const r = db.transaction(storeName).objectStore(storeName).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
function getOne(db, storeName, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(storeName).objectStore(storeName).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function loadAll() {
  const db = await open();
  const players = await getAll(db, "players");
  const kv = await getOne(db, "kv", "app");
  return { players, kv: kv || null };
}

export async function putPlayers(arr) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction("players", "readwrite");
    const s = t.objectStore("players");
    arr.forEach(p => s.put(p));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function deletePlayer(id) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction("players", "readwrite");
    t.objectStore("players").delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function saveKV(kv) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    t.objectStore("kv").put(kv, "app");
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function clearAll() {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(["players", "kv"], "readwrite");
    t.objectStore("players").clear();
    t.objectStore("kv").clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
