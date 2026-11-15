// Import de playlists externes (Deezer par lien, Spotify/autres par fichier CSV ou liste collée).
// On récupère uniquement la LISTE des titres (titre, artiste) : aucune musique n'est téléchargée.
// Les morceaux sont ensuite retrouvés dans TA bibliothèque ; ceux qui manquent sont gardés en attente
// et ajoutés automatiquement quand tu importes les fichiers correspondants.

import * as S from './store.js';

/* --------------------------------- Deezer -------------------------------- */
let jsonpN = 0;
function jsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cb = `__sonoraDz${Date.now()}${jsonpN++}`;
    const s = document.createElement('script');
    const done = () => {
      clearTimeout(t);
      delete window[cb];
      s.remove();
    };
    const t = setTimeout(() => (done(), reject(new Error('Deezer ne répond pas. Vérifie ta connexion.'))), timeout);
    window[cb] = (data) => (done(), resolve(data));
    s.onerror = () => (done(), reject(new Error('Impossible de joindre Deezer. Vérifie ta connexion.')));
    s.src = url + (url.includes('?') ? '&' : '?') + `output=jsonp&callback=${cb}`;
    document.head.appendChild(s);
  });
}

/** Analyse un lien et dit de quel service il vient. */
export function parseLink(raw) {
  const s = String(raw || '').trim();
  let m = /deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i.exec(s);
  if (m) return { service: 'deezer', kind: m[1].toLowerCase(), id: m[2] };
  if (/^\d{5,}$/.test(s)) return { service: 'deezer', kind: 'playlist', id: s };
  if (/(link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)/i.test(s)) return { service: 'deezer-short' };
  if (/spotify\.com|spotify\.link|spotify:/i.test(s)) return { service: 'spotify' };
  if (/music\.apple\.com|youtube\.com|youtu\.be|soundcloud\.com|tidal\.com/i.test(s)) return { service: 'other' };
  return null;
}

export async function fetchDeezer({ kind, id }, onProgress) {
  const base = `https://api.deezer.com/${kind}/${id}`;
  const meta = await jsonp(base);
  if (meta?.error) {
    const code = meta.error.code;
    throw new Error(code === 800 || code === 4 ? 'Playlist introuvable ou privée. Sur Deezer, rends-la publique puis réessaie.' : meta.error.message || 'Erreur Deezer');
  }
  const out = [];
  let index = 0;
  const total = meta.nb_tracks || meta.tracks?.total || 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = await jsonp(`${base}/tracks?limit=100&index=${index}`);
    if (page?.error) throw new Error(page.error.message || 'Erreur Deezer');
    const data = page?.data || [];
    data.forEach((t) =>
      out.push({ title: t.title || t.title_short, artist: t.artist?.name || meta.artist?.name || '', album: t.album?.title || meta.title || '', duration: t.duration || 0 }),
    );
    onProgress?.(out.length, total || page.total || out.length);
    if (!page.next || !data.length) break;
    index += data.length;
  }
  return { name: meta.title || 'Playlist Deezer', source: 'Deezer', tracks: out };
}

/* ------------------------------- CSV / texte ------------------------------ */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** CSV Exportify (Spotify), TuneMyMusic, Soundiiz… : colonnes titre / artiste détectées automatiquement. */
export function parseCsv(text, fileName = 'Playlist') {
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('Fichier vide ou illisible.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  // Priorité à l'ordre des noms : d'abord une colonne exacte, puis une colonne qui contient le nom
  const find = (...names) => {
    for (const n of names) {
      const exact = head.indexOf(n);
      if (exact >= 0) return exact;
      const part = head.findIndex((h) => h.includes(n) && !/uri|url|id$|isrc|link/.test(h));
      if (part >= 0) return part;
    }
    return -1;
  };
  const ti = find('track name', 'track title', 'song name', 'titre', 'title', 'name', 'track');
  const ai = find('artist name', 'artist', 'artiste');
  const al = find('album name', 'album');
  const du = find('duration (ms)', 'duration', 'durée');
  if (ti < 0) throw new Error('Colonne « titre » introuvable dans le fichier.');
  const tracks = rows
    .slice(1)
    .map((r) => {
      let d = du >= 0 ? parseFloat(r[du]) || 0 : 0;
      if (d > 10000) d /= 1000; // millisecondes
      return { title: (r[ti] || '').trim(), artist: ai >= 0 ? (r[ai] || '').split(/[,;]/)[0].trim() : '', album: al >= 0 ? (r[al] || '').trim() : '', duration: d };
    })
    .filter((t) => t.title);
  return { name: fileName.replace(/\.(csv|txt)$/i, '').replace(/[_]+/g, ' ').trim() || 'Playlist importée', source: 'CSV', tracks };
}

/** Liste collée : une ligne par titre, « Artiste - Titre » (ou « Titre » seul). */
export function parseText(text) {
  const tracks = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.split(/\s+[-–—]\s+/);
      return p.length >= 2 ? { artist: p[0].trim(), title: p.slice(1).join(' - ').trim() } : { artist: '', title: l };
    });
  return { name: 'Playlist importée', source: 'Liste', tracks };
}

/* ------------------------------ correspondance ---------------------------- */
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Titre « nettoyé » : sans (feat. …), [Remastered], - Radio Edit, etc. */
const cleanTitle = (t) =>
  norm(
    String(t || '')
      .replace(/\s*[([].*?[)\]]\s*/g, ' ')
      .replace(/\s+[-–—]\s+.*(remaster|version|edit|live|mix|mono|stereo|deluxe|bonus|acoustic|original).*$/i, '')
      .replace(/\s+(feat|ft|featuring)\.?\s+.*$/i, ''),
  );
const artistTokens = (a) =>
  norm(String(a || '').split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\bet\b|\band\b/i)[0])
    .split(' ')
    .filter((w) => w.length > 1);

function buildIndex() {
  const byTitle = new Map();
  for (const t of S.allTracks()) {
    const keys = new Set([cleanTitle(t.title), norm(t.title), cleanTitle(t.fileName.replace(/\.[^.]+$/, '').split(/\s+[-–—]\s+/).pop())]);
    keys.forEach((k) => {
      if (!k) return;
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k).push(t);
    });
  }
  return byTitle;
}

function matchOne(item, index, used) {
  const keys = [cleanTitle(item.title), norm(item.title)];
  let cands = [];
  for (const k of keys) if (index.has(k)) cands = cands.concat(index.get(k));
  cands = [...new Set(cands)].filter((t) => !used.has(t.id));
  if (!cands.length) return null;
  const at = artistTokens(item.artist);
  const scored = cands
    .map((t) => {
      let s = 1;
      const hay = norm(`${t.artist} ${t.fileName}`);
      if (at.length && at.every((w) => hay.includes(w))) s += 5;
      else if (at.some((w) => hay.includes(w))) s += 2;
      if (item.duration && t.duration && Math.abs(item.duration - t.duration) <= 3) s += 2;
      return { t, s };
    })
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  // Artiste inconnu dans la bibliothèque : on accepte si le titre est unique
  const unknownArtist = !best.t.artist || best.t.artist === 'Artiste inconnu';
  if (best.s >= 3 || !at.length || (unknownArtist && cands.length === 1)) return best.t;
  return null;
}

/** Associe une liste externe à la bibliothèque. */
export function matchTracks(items) {
  const index = buildIndex();
  const used = new Set();
  const found = [];
  const missing = [];
  items.forEach((it) => {
    const t = matchOne(it, index, used);
    if (t) {
      used.add(t.id);
      found.push(t.id);
    } else missing.push({ title: it.title, artist: it.artist, duration: it.duration || 0 });
  });
  return { found, missing };
}

/** Crée la playlist SONORA (titres trouvés + titres en attente). */
export function createFromImport(list) {
  const { found, missing } = matchTracks(list.tracks);
  const id = S.createPlaylist(list.name, found);
  S.patchPlaylist(id, { missing, source: list.source });
  return { id, found: found.length, missing: missing.length, total: list.tracks.length };
}

/** Après un import de fichiers : complète les playlists qui attendaient ces morceaux. */
export function fillMissing() {
  let added = 0;
  for (const p of S.state.playlists) {
    if (!p.missing?.length) continue;
    const { found, missing } = matchTracks(p.missing);
    const fresh = found.filter((id) => !p.trackIds.includes(id));
    if (!fresh.length) continue;
    added += fresh.length;
    S.patchPlaylist(p.id, { trackIds: [...p.trackIds, ...fresh], missing });
  }
  return added;
}

/**
 * Fonction qui dit si un fichier correspond à un titre en attente
 * (d'une playlist précise, ou de toutes les playlists si playlistId est absent).
 */
export function wantedMatcher(playlistId) {
  const wanted = new Map();
  for (const p of S.state.playlists) {
    if (playlistId && p.id !== playlistId) continue;
    for (const m of p.missing || []) {
      for (const k of [cleanTitle(m.title), norm(m.title)]) {
        if (!k) continue;
        if (!wanted.has(k)) wanted.set(k, []);
        wanted.get(k).push(m);
      }
    }
  }
  const count = new Set([...wanted.values()].flat()).size;
  const accept = (file) => {
    const base = file.fileName.replace(/\.[^.]+$/, '');
    const titles = [file.title, base.split(/\s+[-–—]\s+/).pop(), base];
    for (const t of titles) {
      for (const k of [cleanTitle(t), norm(t)]) {
        const items = wanted.get(k);
        if (!items) continue;
        const hay = norm(`${file.artist} ${base}`);
        if (items.some((m) => { const at = artistTokens(m.artist); return !at.length || at.some((w) => hay.includes(w)) || !file.artist; })) return true;
      }
    }
    return false;
  };
  return { accept, count };
}
