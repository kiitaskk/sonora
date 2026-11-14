// Stockage local SONORA (IndexedDB) : fichiers audio, pochettes et données de la bibliothèque.
// Rien ne quitte l'appareil.
const DB_NAME = 'sonora';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' }); // métadonnées
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs'); // fichiers audio / images
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); // playlists, favoris, stats…
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Transaction annulée (espace insuffisant ?)'));
      }),
  );
}

const req = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export const db = {
  allTracks: () => tx('tracks', 'readonly', (s) => req(s.getAll())),
  putTrack: (t) => tx('tracks', 'readwrite', (s) => s.put(t)),
  putTracks: (list) => tx('tracks', 'readwrite', (s) => list.forEach((t) => s.put(t))),
  deleteTracks: (ids) => tx('tracks', 'readwrite', (s) => ids.forEach((id) => s.delete(id))),

  getBlob: (key) => tx('blobs', 'readonly', (s) => req(s.get(key))),
  putBlob: (key, blob) => tx('blobs', 'readwrite', (s) => s.put(blob, key)),
  deleteBlobs: (keys) => tx('blobs', 'readwrite', (s) => keys.forEach((k) => k && s.delete(k))),
  blobKeys: () => tx('blobs', 'readonly', (s) => req(s.getAllKeys())),

  get: (key) => tx('kv', 'readonly', (s) => req(s.get(key))),
  set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),

  async clearAll() {
    await tx('tracks', 'readwrite', (s) => s.clear());
    await tx('blobs', 'readwrite', (s) => s.clear());
    await tx('kv', 'readwrite', (s) => s.clear());
  },
};

/** Demande au navigateur de ne jamais effacer les données (important sur iPhone). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
