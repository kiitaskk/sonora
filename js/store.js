// État de la bibliothèque SONORA + persistance IndexedDB.
import { db } from './db.js';
import { probeDuration, readTags, tagsFromFileName } from './tags.js';

export const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus'];
const HISTORY_LIMIT = 2000;

export const state = {
  tracks: new Map(),
  playlists: [],
  favorites: [],
  history: [],
  playCounts: {},
  listenSeconds: {},
  settings: { theme: 'dark', accent: 'aurora', sortKey: 'added', sortDesc: false, autoResume: true },
  session: null,
};

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(() => {
    emitQueued = false;
    listeners.forEach((f) => f());
  });
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { playlists, favorites, history, playCounts, listenSeconds, settings, session } = state;
    db.set('library', { playlists, favorites, history, playCounts, listenSeconds, settings, session }).catch(console.warn);
  }, 300);
}
export function saveNow() {
  clearTimeout(saveTimer);
  const { playlists, favorites, history, playCounts, listenSeconds, settings, session } = state;
  return db.set('library', { playlists, favorites, history, playCounts, listenSeconds, settings, session });
}
const changed = () => (save(), emit());

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

export async function loadLibrary() {
  const [tracks, lib] = await Promise.all([db.allTracks(), db.get('library')]);
  tracks.forEach((t) => state.tracks.set(t.id, t));
  if (lib) Object.assign(state, { ...lib, settings: { ...state.settings, ...lib.settings } });
}

export const allTracks = () => [...state.tracks.values()];
export const getTrack = (id) => state.tracks.get(id);

/* ------------------------------ pochettes ------------------------------ */
const urlCache = new Map();
export async function blobUrl(key) {
  if (!key) return null;
  if (urlCache.has(key)) return urlCache.get(key);
  const b = await db.getBlob(key);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(key, u);
  return u;
}
export const cachedUrl = (key) => (key ? urlCache.get(key) : null);
function dropUrl(key) {
  const u = urlCache.get(key);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(key);
}

/* -------------------------------- import ------------------------------- */
const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n)?.[1] || '').toLowerCase();

export async function importFiles(files, onProgress, { accept } = {}) {
  const known = new Set(allTracks().map((t) => `${t.fileName}::${t.size}`));
  const res = { imported: 0, duplicates: 0, skipped: [], ignored: 0 };
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    onProgress?.(i, list.length, f.name);
    const ext = extOf(f.name);
    if (!AUDIO_EXT.includes(ext) && !f.type.startsWith('audio/')) {
      res.skipped.push(f.name);
      continue;
    }
    if (known.has(`${f.name}::${f.size}`)) {
      res.duplicates++;
      continue;
    }
    try {
      const id = uid();
      const tags = await readTags(f);
      const fn = tagsFromFileName(f.name);
      // Mode « Retrouver les fichiers » : on n'enregistre que les morceaux recherchés
      if (accept && !accept({ title: tags.title || fn.title, artist: tags.artist || fn.artist || '', fileName: f.name, duration: tags.duration || 0 })) {
        res.ignored++;
        continue;
      }
      const audioKey = 'audio:' + id;
      await db.putBlob(audioKey, f);
      let artKey;
      if (tags.picture) {
        artKey = 'art:' + id;
        await db.putBlob(artKey, tags.picture);
      }
      const duration = tags.duration || (await probeDuration(f));
      const t = {
        id,
        audioKey,
        artKey,
        fileName: f.name,
        mime: f.type || 'audio/' + ext,
        title: tags.title || fn.title,
        artist: tags.artist || fn.artist || 'Artiste inconnu',
        album: tags.album || 'Album inconnu',
        genre: tags.genre || '',
        duration,
        size: f.size,
        addedAt: Date.now() + i,
      };
      await db.putTrack(t);
      state.tracks.set(id, t);
      known.add(`${f.name}::${f.size}`);
      res.imported++;
      emit();
    } catch (e) {
      console.warn('import', f.name, e);
      res.skipped.push(f.name + (e?.name === 'QuotaExceededError' ? ' (espace plein)' : ''));
    }
  }
  onProgress?.(list.length, list.length);
  return res;
}

export async function updateTrack(id, patch) {
  const t = state.tracks.get(id);
  if (!t) return;
  const next = { ...t, ...patch };
  state.tracks.set(id, next);
  await db.putTrack(next);
  emit();
}

export async function setTrackArtwork(ids, file) {
  for (const id of ids) {
    const t = state.tracks.get(id);
    if (!t) continue;
    const key = 'art:' + id;
    dropUrl(key);
    if (file) await db.putBlob(key, file);
    else await db.deleteBlobs([key]);
    await updateTrack(id, { artKey: file ? key : undefined, artVer: Date.now() });
  }
}

export async function removeTracks(ids) {
  const del = new Set(ids);
  const keys = [];
  ids.forEach((id) => {
    const t = state.tracks.get(id);
    if (t) keys.push(t.audioKey, t.artKey);
    if (t?.artKey) dropUrl(t.artKey);
    state.tracks.delete(id);
    delete state.playCounts[id];
    delete state.listenSeconds[id];
  });
  state.favorites = state.favorites.filter((f) => !del.has(f));
  state.history = state.history.filter((h) => !del.has(h.trackId));
  state.playlists = state.playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter((x) => !del.has(x)) }));
  await db.deleteTracks(ids);
  await db.deleteBlobs(keys);
  changed();
}

/* ------------------------------- favoris ------------------------------- */
export const isFav = (id) => state.favorites.includes(id);
export function toggleFav(id) {
  state.favorites = isFav(id) ? state.favorites.filter((f) => f !== id) : [id, ...state.favorites];
  changed();
  return isFav(id);
}

/* ------------------------------ playlists ------------------------------ */
export const getPlaylist = (id) => state.playlists.find((p) => p.id === id);
export function createPlaylist(name, trackIds = []) {
  const p = { id: uid(), name: name.trim() || 'Nouvelle playlist', trackIds: [...trackIds], createdAt: Date.now() };
  state.playlists = [p, ...state.playlists];
  changed();
  return p.id;
}
function patchPl(id, fn) {
  state.playlists = state.playlists.map((p) => (p.id === id ? fn(p) : p));
  changed();
}
export const patchPlaylist = (id, patch) => patchPl(id, (p) => ({ ...p, ...patch }));
export const renamePlaylist = (id, name) => patchPl(id, (p) => ({ ...p, name: name.trim() || p.name }));
export function addToPlaylist(id, ids) {
  let n = 0;
  patchPl(id, (p) => {
    const fresh = ids.filter((x) => !p.trackIds.includes(x));
    n = fresh.length;
    return { ...p, trackIds: [...p.trackIds, ...fresh] };
  });
  return n;
}
export const removeFromPlaylist = (id, idx) => patchPl(id, (p) => ({ ...p, trackIds: p.trackIds.filter((_, i) => i !== idx) }));
export function movePlaylistTrack(id, from, to) {
  patchPl(id, (p) => {
    if (to < 0 || to >= p.trackIds.length) return p;
    const a = [...p.trackIds];
    a.splice(to, 0, a.splice(from, 1)[0]);
    return { ...p, trackIds: a };
  });
}
export async function setPlaylistImage(id, file) {
  const key = 'pl:' + id;
  dropUrl(key);
  if (file) await db.putBlob(key, file);
  else await db.deleteBlobs([key]);
  patchPl(id, (p) => ({ ...p, imageKey: file ? key : undefined }));
}
export async function deletePlaylist(id) {
  const p = getPlaylist(id);
  if (p?.imageKey) await db.deleteBlobs([p.imageKey]);
  state.playlists = state.playlists.filter((x) => x.id !== id);
  changed();
}

/* ------------------------------ statistiques --------------------------- */
export function logPlay(id) {
  state.history.unshift({ trackId: id, at: Date.now() });
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  state.playCounts[id] = (state.playCounts[id] || 0) + 1;
  changed();
}
export function addListen(id, sec) {
  state.listenSeconds[id] = (state.listenSeconds[id] || 0) + sec;
  save();
}
export const clearHistory = () => ((state.history = []), changed());
export const resetStats = () => ((state.history = []), (state.playCounts = {}), (state.listenSeconds = {}), changed());

export function setSettings(patch) {
  Object.assign(state.settings, patch);
  changed();
}
export function setSession(s) {
  state.session = s;
  save();
}

export async function wipeAll() {
  urlCache.forEach((u) => URL.revokeObjectURL(u));
  urlCache.clear();
  await db.clearAll();
  state.tracks.clear();
  Object.assign(state, { playlists: [], favorites: [], history: [], playCounts: {}, listenSeconds: {}, session: null });
  await saveNow();
  emit();
}

/* ------------------------------- sauvegarde ---------------------------- */
export function buildBackup() {
  const ref = (id) => {
    const t = state.tracks.get(id);
    return t ? { title: t.title, artist: t.artist, fileName: t.fileName } : null;
  };
  return {
    app: 'sonora',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: state.playlists.map((p) => ({ name: p.name, createdAt: p.createdAt, tracks: p.trackIds.map(ref).filter(Boolean) })),
    favorites: state.favorites.map(ref).filter(Boolean),
  };
}

export function restoreBackup(data) {
  if (data?.app !== 'sonora' || !Array.isArray(data.playlists)) throw new Error('Fichier de sauvegarde invalide');
  const all = allTracks();
  const byFile = new Map(all.map((t) => [t.fileName, t.id]));
  const byMeta = new Map(all.map((t) => [`${t.title}|${t.artist}`.toLowerCase(), t.id]));
  let missing = 0;
  const find = (r) => {
    const id = byFile.get(r.fileName) ?? byMeta.get(`${r.title}|${r.artist}`.toLowerCase());
    if (!id) missing++;
    return id;
  };
  const pls = data.playlists.map((p) => ({ id: uid(), name: p.name, createdAt: p.createdAt || Date.now(), trackIds: p.tracks.map(find).filter(Boolean) }));
  state.playlists = [...pls, ...state.playlists];
  (data.favorites || []).map(find).filter(Boolean).forEach((id) => !isFav(id) && state.favorites.push(id));
  changed();
  return { count: pls.length, missing };
}

/** Morceaux sans durée (ex. import interrompu) : calcul en arrière-plan. */
export async function fixDurations() {
  for (const t of allTracks()) {
    if (t.duration) continue;
    const b = await db.getBlob(t.audioKey);
    if (!b) continue;
    const d = await probeDuration(b);
    if (d) await updateTrack(t.id, { duration: d });
  }
}
