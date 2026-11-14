// SONORA — application web installable (PWA). Pages, navigation et interactions.
import { requestPersistence, storageEstimate } from './db.js';
import { icon } from './icons.js';
import { initPlayer, isIOS, onProgress, P, Player } from './player.js';
import * as S from './store.js';
import * as IMP from './importer.js';
import {
  art,
  closeSheet,
  compareFr,
  dialog,
  emptyState,
  esc,
  fmtBytes,
  fmtLong,
  fmtTime,
  hashColors,
  hydrateArt,
  normalize,
  openSheet,
  pickFile,
  plural,
  shuffle,
  SORT_LABELS,
  sortTracks,
  toast,
} from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const ui = {
  libView: 'tracks',
  libFilter: null,
  selection: null,
  q: '',
  field: 'all',
  importing: null,
  plEdit: false,
  playerOpen: false,
  showMissing: true,
  hintClosed: localStorage.getItem('sonora-hint') === '1',
};
/** Listes affichées : data-play="nom:index" lance la lecture depuis la bonne liste. */
const lists = {};

/* ================================ RENDU ================================ */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  return { name: name || 'home', id: id ? decodeURIComponent(id) : undefined };
}

let lastRouteKey = '';
function render() {
  const r = route();
  const key = r.name + '/' + (r.id || '');
  // Ne pas casser la saisie en cours (recherche, champs)
  const active = document.activeElement;
  if (key === lastRouteKey && active && view.contains(active) && active.matches('input')) {
    if (r.name === 'search') renderSearchResults();
    updateChrome();
    return;
  }
  const scroll = key === lastRouteKey ? view.scrollTop : 0;
  const fn = VIEWS[r.name] || VIEWS.home;
  view.innerHTML = fn(r.id);
  if (key !== lastRouteKey) {
    view.classList.remove('page-enter');
    void view.offsetWidth;
    view.classList.add('page-enter');
  }
  lastRouteKey = key;
  view.scrollTop = scroll;
  if (r.name === 'search') renderSearchResults();
  hydrateArt(view);
  updateChrome();
}

function updateChrome() {
  const r = route();
  const tabOf = { home: 'home', search: 'search', library: 'library', playlists: 'playlists', playlist: 'playlists', favorites: 'playlists', settings: 'settings', stats: 'home', history: 'home' };
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tabOf[r.name]));
  renderMini();
  if (ui.playerOpen) renderPlayer();
}

function trackRow(t, listName, i, { index = false, side = null, ctx = '' } = {}) {
  const cur = P.queue[P.index] === t.id;
  const fav = S.isFav(t.id);
  return `<div class="trow ${cur ? 'current' : ''}" data-act="play" data-play="${listName}:${i}">
    ${index ? `<div class="idx">${i + 1}</div>` : ''}
    <div style="position:relative">${art(t.artKey, t.album + t.artist, 50, { radius: 10 })}${
      cur ? `<div class="art bars ${P.playing ? '' : 'paused'}" style="position:absolute;inset:0;border-radius:10px"><i></i><i></i><i></i></div>` : ''
    }</div>
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${fav ? `<span class="heart">${icon('heart', 12)}</span>` : ''}<span>${esc(t.artist)}${
      t.album && t.album !== 'Album inconnu' ? ' · ' + esc(t.album) : ''
    }</span></div></div>
    ${side ?? `<div class="dur">${fmtTime(t.duration)}</div><button class="icon-btn side" data-act="more" data-id="${t.id}" ${ctx} aria-label="Options">${icon('more', 20)}</button>`}
  </div>`;
}

function shelf(tracks, listName, size = 140) {
  lists[listName] = tracks.map((t) => t.id);
  return `<div class="shelf">${tracks
    .map(
      (t, i) => `<div class="shelf-item" style="width:${size}px" data-act="play" data-play="${listName}:${i}">
        ${art(t.artKey, t.album + t.artist, size, { radius: 16, cls: 'shadow' })}
        <div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div>`,
    )
    .join('')}</div>`;
}

const section = (title, body, action = '', actionAttr = '') =>
  `<div class="section"><div class="section-title"><h2>${esc(title)}</h2>${action ? `<button class="link" ${actionAttr}>${esc(action)}</button>` : ''}</div>${body}</div>`;

const backBar = (right = '') =>
  `<div class="row-between" style="padding:0 8px"><button class="icon-btn" data-act="back" aria-label="Retour">${icon('back', 26)}</button><div style="display:flex">${right}</div></div>`;

function importCard() {
  const p = ui.importing;
  if (!p) return '';
  return `<div class="progress-card"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Import ${p.done}/${p.total}${p.name ? ' · ' + esc(p.name) : ''}</div><div class="meter"><div style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></div></div></div>`;
}

const importBtn = (cls = 'grad') =>
  `<button class="btn ${cls}" data-act="import" ${ui.importing ? 'disabled' : ''}>${icon('import', 18)}${ui.importing ? 'Import en cours…' : 'Importer des musiques'}</button>`;

/* ================================ PAGES ================================ */
const VIEWS = {
  home() {
    const all = S.allTracks();
    const h = new Date().getHours();
    const greet = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    const hint =
      isIOS && !standalone && !ui.hintClosed
        ? `<div class="install-hint">${icon('share', 22)}<div><b>Installe SONORA</b><br><span class="muted">Dans Safari : bouton Partager, puis « Sur l’écran d’accueil ». L’app s’ouvrira en plein écran, comme une vraie app.</span></div><button class="x" data-act="hide-hint" aria-label="Fermer">${icon('close', 18)}</button></div>`
        : '';
    let html = `<div class="row-between pad"><div class="wordmark"><div class="logo"><i style="height:9px"></i><i style="height:16px"></i><i style="height:11px"></i></div>SONORA</div>
      <button class="icon-btn" data-go="#/stats" aria-label="Statistiques">${icon('stats', 22)}</button></div>
      <div class="greet">${greet}</div>${hint}`;
    if (!all.length) {
      return html + importCard() + emptyState('note', 'Ta bibliothèque est vide', 'Importe tes fichiers MP3, WAV, FLAC, AAC, M4A ou OGG depuis l’app Fichiers. Ils sont gardés dans SONORA et restent écoutables sans Internet.', importBtn());
    }
    const seen = new Set();
    const recent = [];
    for (const e of S.state.history) {
      const t = S.getTrack(e.trackId);
      if (t && !seen.has(t.id)) (seen.add(t.id), recent.push(t));
      if (recent.length >= 12) break;
    }
    const favs = S.state.favorites.map(S.getTrack).filter(Boolean).slice(0, 12);
    const added = sortTracks(all, 'added').slice(0, 12);
    const pc = S.state.playCounts;
    const top = all.filter((t) => pc[t.id]).sort((a, b) => pc[b.id] - pc[a.id]).slice(0, 12);
    const last = recent[0];
    const same = last ? all.filter((t) => t.artist === last.artist && t.id !== last.id) : [];
    const never = all.filter((t) => !pc[t.id]);
    const reco = same.length >= 2 ? { t: `Plus de ${last.artist}`, l: shuffle(same) } : { t: 'À découvrir dans ta bibliothèque', l: shuffle(never.length ? never : all) };
    lists.all = all.map((t) => t.id);
    lists.added = added.map((t) => t.id);

    html += importCard();
    html += `<div class="tiles">
      <button class="tile" data-go="#/favorites"><span class="ti" style="background:linear-gradient(135deg,#ff4d7a,#b23aff)">${icon('heart', 18)}</span>Favoris</button>
      <button class="tile" data-act="shuffle-all"><span class="ti">${icon('shuffle', 18)}</span>Aléatoire</button>
      <button class="tile" data-go="#/history"><span class="ti" style="background:linear-gradient(135deg,#2e7bff,#20d8c4)">${icon('clock', 18)}</span>Historique</button>
      <button class="tile" data-act="play" data-play="added:0"><span class="ti" style="background:linear-gradient(135deg,#ff7a45,#ffc145)">${icon('sparkles', 18)}</span>Ajouts récents</button>
    </div>`;
    const s = S.state.session;
    const resume = !P.playing && s && S.getTrack(s.queue?.[s.index]);
    if (resume && P.queue.length) {
      html += `<button class="resume" style="width:calc(100% - 32px);text-align:left" data-act="resume">${art(resume.artKey, resume.album + resume.artist, 56, { radius: 12 })}
        <div style="flex:1;min-width:0"><div class="k">REPRENDRE</div><div class="t">${esc(resume.title)}</div><div class="muted" style="font-size:12px">${esc(resume.artist)} · à ${fmtTime(P.position || s.position)}</div></div>
        <span style="color:var(--a)">${icon('play', 34)}</span></button>`;
    }
    if (recent.length) html += section('Écoutés récemment', shelf(recent, 'recent'), 'Tout voir', 'data-go="#/history"');
    if (favs.length) html += section('Tes favoris', shelf(favs, 'favs', 120), 'Tout voir', 'data-go="#/favorites"');
    if (reco.l.length) html += section(reco.t, shelf(reco.l.slice(0, 12), 'reco'));
    if (top.length >= 3) html += section('Tes plus écoutés', shelf(top, 'top', 120), 'Stats', 'data-go="#/stats"');
    html += section('Ajoutés récemment', shelf(added, 'added2', 120), 'Bibliothèque', 'data-go="#/library"');
    return html;
  },

  search() {
    const fields = [['all', 'Tout'], ['title', 'Titre'], ['artist', 'Artiste'], ['album', 'Album'], ['genre', 'Genre']];
    return `<h1 class="title pad" style="margin-bottom:14px">Recherche</h1>
      <label class="searchbox">${icon('search', 20)}<input id="q" type="search" placeholder="Titre, artiste, album, genre…" value="${esc(ui.q)}" autocomplete="off" autocorrect="off" enterkeyhint="search" />
      ${ui.q ? `<button data-act="clear-q" aria-label="Effacer">${icon('close', 18)}</button>` : ''}</label>
      <div class="chips">${fields.map(([k, l]) => `<button class="chip ${ui.field === k ? 'on' : ''}" data-act="field" data-k="${k}">${l}</button>`).join('')}</div>
      <div id="results"></div>`;
  },

  library() {
    const all = S.allTracks();
    const total = all.reduce((a, t) => a + (t.duration || 0), 0);
    const { sortKey, sortDesc } = S.state.settings;
    let html = `<div class="row-between pad"><h1 class="title">Bibliothèque</h1><div style="display:flex">
      ${all.length ? `<button class="icon-btn" data-act="select-mode" aria-label="Sélection">${icon(ui.selection ? 'close' : 'select', 24)}</button>` : ''}
      <button class="icon-btn accent" data-act="import" aria-label="Importer">${icon('plusCircle', 30)}</button></div></div>
      <p class="muted pad" style="margin:2px 0 14px">${plural(all.length, 'morceau', 'morceaux')}${total ? ' · ' + fmtLong(total) : ''}</p>${importCard()}`;
    if (!all.length) return html + emptyState('library', 'Aucune musique pour l’instant', 'Appuie sur + pour importer des fichiers (sélection multiple possible).', importBtn());

    html += `<div class="chips">${[['tracks', 'Morceaux'], ['artists', 'Artistes'], ['albums', 'Albums']]
      .map(([k, l]) => `<button class="chip ${ui.libView === k && !ui.libFilter ? 'on' : ''}" data-act="libview" data-k="${k}">${l}</button>`)
      .join('')}</div>`;

    if (ui.libView !== 'tracks' && !ui.libFilter) {
      const isArt = ui.libView === 'artists';
      const groups = new Map();
      all.forEach((t) => {
        const k = isArt ? t.artist : t.album;
        const g = groups.get(k) || { k, n: 0, artKey: null, sub: t.artist };
        g.n++;
        if (!g.artKey && t.artKey) g.artKey = t.artKey;
        groups.set(k, g);
      });
      const arr = [...groups.values()].sort((a, b) => compareFr(a.k, b.k));
      return (
        html +
        `<div class="grid2">${arr
          .map(
            (g) => `<button class="gcard ${isArt ? 'center' : ''}" data-act="libfilter" data-type="${isArt ? 'artist' : 'album'}" data-v="${esc(g.k)}">
            ${art(g.artKey, g.k, 160, { radius: isArt ? 999 : 16, ic: isArt ? 'person' : 'disc' })}
            <div class="t">${esc(g.k)}</div><div class="s">${isArt ? plural(g.n, 'morceau', 'morceaux') : esc(g.sub) + ' · ' + plural(g.n, 'titre')}</div></button>`,
          )
          .join('')}</div>`
      );
    }

    let list = all;
    if (ui.libFilter) list = all.filter((t) => (ui.libFilter.type === 'artist' ? t.artist : t.album) === ui.libFilter.v);
    list = ui.libFilter?.type === 'album' && sortKey === 'added' ? sortTracks(list, 'title') : sortTracks(list, sortKey, sortDesc);
    lists.lib = list.map((t) => t.id);

    if (ui.libFilter) html += `<button class="row-between" data-act="libfilter-clear" style="gap:4px;padding:0 12px 12px;justify-content:flex-start;color:var(--a)">${icon('back', 20)}<span style="color:var(--text);font-size:20px;font-weight:800">${esc(ui.libFilter.v)}</span></button>`;
    html += `<div class="btns"><button class="btn grad sm" data-act="play" data-play="lib:0" data-noshuffle="1">${icon('play', 16)}Lire</button><button class="btn ghost sm" data-act="shuffle-list" data-list="lib">${icon('shuffle', 16)}Aléatoire</button></div>
      <div class="chips"><button class="chip round" data-act="sort-dir" aria-label="Inverser l’ordre">${icon(sortDesc ? 'up' : 'down', 16)}</button>${Object.entries(SORT_LABELS)
        .map(([k, l]) => `<button class="chip ${sortKey === k ? 'on' : ''}" data-act="sort" data-k="${k}">${l}</button>`)
        .join('')}</div>`;
    html += list
      .map((t, i) =>
        ui.selection
          ? trackRow(t, 'lib', i, { side: `<span class="side" style="color:${ui.selection.has(t.id) ? 'var(--a)' : 'var(--faint)'}">${icon(ui.selection.has(t.id) ? 'checkCircle' : 'circle', 24)}</span>` }).replace('data-act="play"', `data-act="sel" data-id="${t.id}"`)
          : trackRow(t, 'lib', i),
      )
      .join('');
    if (ui.selection) {
      const n = ui.selection.size;
      html += `<div class="selbar"><span class="grow">${n} sélectionné${n > 1 ? 's' : ''}</span>
        <button class="icon-btn" data-act="sel-all" aria-label="Tout sélectionner">${icon('selectAll', 22)}</button>
        <button class="icon-btn" data-act="sel-pl" ${n ? '' : 'disabled'} aria-label="Ajouter à une playlist">${icon('plusCircle', 22)}</button>
        <button class="icon-btn" data-act="sel-next" ${n ? '' : 'disabled'} aria-label="Lire ensuite">${icon('playNext', 22)}</button>
        <button class="icon-btn" style="color:var(--danger)" data-act="sel-del" ${n ? '' : 'disabled'} aria-label="Supprimer">${icon('trash', 22)}</button></div>`;
    }
    return html;
  },

  playlists() {
    const pls = S.state.playlists;
    let html = `<div class="row-between pad" style="margin-bottom:12px"><h1 class="title">Playlists</h1><button class="icon-btn accent" data-act="new-pl" aria-label="Nouvelle playlist">${icon('plusCircle', 30)}</button></div>
      <button class="list-row" style="width:100%;text-align:left" data-go="#/favorites"><div class="fav-art">${icon('heart', 28)}</div><div style="flex:1"><div class="t">Titres likés</div><div class="muted" style="font-size:13px">Playlist automatique · ${plural(S.state.favorites.length, 'titre')}</div></div><span class="faint">${icon('right', 20)}</span></button>
      <button class="list-row" style="width:100%;text-align:left" data-act="import-pl"><div class="fav-art" style="background:linear-gradient(135deg,#a238ff,#ef5466)">${icon('import', 26)}</div><div style="flex:1"><div class="t">Importer une playlist</div><div class="muted" style="font-size:13px">Lien Deezer, export Spotify, liste…</div></div><span class="faint">${icon('right', 20)}</span></button>`;
    if (!pls.length) return html + emptyState('playlists', 'Crée ta première playlist', 'Autant de playlists que tu veux, avec ton image et l’ordre de ton choix.', `<button class="btn grad" data-act="new-pl">${icon('plus', 18)}Nouvelle playlist</button>`);
    return (
      html +
      pls
        .map(
          (p) => `<button class="list-row" style="width:100%;text-align:left" data-go="#/playlist/${p.id}">${art(p.imageKey, p.id, 64, { radius: 12, ic: 'playlists' })}
          <div style="flex:1;min-width:0"><div class="t" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div><div class="muted" style="font-size:13px">${plural(p.trackIds.length, 'titre')}${p.missing?.length ? ` · ${p.missing.length} en attente` : ''}${p.source && p.source !== 'Liste' ? ` · ${esc(p.source)}` : ''}</div></div><span class="faint">${icon('right', 20)}</span></button>`,
        )
        .join('')
    );
  },

  playlist(id) {
    const p = S.getPlaylist(id);
    if (!p) return backBar() + emptyState('playlists', 'Playlist introuvable');
    const tracks = p.trackIds.map(S.getTrack).filter(Boolean);
    lists['pl'] = tracks.map((t) => t.id);
    const dur = tracks.reduce((a, t) => a + (t.duration || 0), 0);
    const [c1] = hashColors(p.id);
    let html = `<div class="hero" style="background:linear-gradient(${c1}99, transparent 75%);margin-top:calc(-12px - var(--sat));padding-top:calc(var(--sat) + 8px)">
      <div class="topbar"><button class="icon-btn" data-act="back" aria-label="Retour">${icon('back', 26)}</button><div style="display:flex">
        <button class="icon-btn" data-act="pl-edit" aria-label="Réorganiser">${icon(ui.plEdit ? 'check' : 'swap', 22)}</button>
        <button class="icon-btn" data-act="pl-menu" data-id="${p.id}" aria-label="Options">${icon('more', 22)}</button></div></div>
      <button class="cover" data-act="pl-image" data-id="${p.id}" aria-label="Changer l’image">${art(p.imageKey, p.id, 210, { radius: 18, ic: 'playlists', cls: 'shadow' })}${p.imageKey ? '' : `<span class="cam">${icon('image', 16)}</span>`}</button>
      <h1 data-act="pl-rename" data-id="${p.id}">${esc(p.name)}</h1>
      <p class="muted">${plural(tracks.length, 'titre')}${dur ? ' · ' + fmtLong(dur) : ''}</p>
      <div class="actions-row"><button class="btn ghost sm" data-act="pl-add" data-id="${p.id}">${icon('plus', 16)}Ajouter</button><div style="flex:1"></div>
        <button class="icon-btn" data-act="shuffle-list" data-list="pl" ${tracks.length ? '' : 'disabled'} aria-label="Aléatoire">${icon('shuffle', 26)}</button>
        <button class="play-big" data-act="play" data-play="pl:0" data-noshuffle="1" ${tracks.length ? '' : 'disabled'} aria-label="Lire">${icon('play', 28)}</button></div></div>`;
    const miss = p.missing || [];
    const missHtml = miss.length
      ? `<div class="section" style="margin-top:20px"><button class="section-title" style="width:100%" data-act="toggle-missing"><h2 style="font-size:17px">En attente · ${miss.length}</h2><span class="faint">${icon(ui.showMissing ? 'up' : 'down', 20)}</span></button>
        <p class="muted pad" style="font-size:13px;line-height:1.4;margin-top:-6px">Ces titres ne sont pas encore dans ta bibliothèque. Importe leurs fichiers : ils s’ajouteront tout seuls à cette playlist.</p>
        ${ui.showMissing ? miss.map((m) => `<div class="trow" style="opacity:.55"><div class="art" style="width:44px;height:44px;border-radius:8px;background:var(--card2)"><span class="art-ic" style="color:var(--faint)">${icon('note', 18)}</span></div><div class="meta"><div class="t" style="font-size:15px">${esc(m.title)}</div><div class="s">${esc(m.artist || 'Artiste inconnu')}</div></div></div>`).join('') + `<div class="btns" style="margin-top:8px"><button class="btn ghost sm" data-act="import">${icon('import', 16)}Importer des fichiers</button><button class="btn ghost sm" style="color:var(--danger)" data-act="clear-missing" data-id="${p.id}">Ne plus attendre</button></div>` : ''}</div>`
      : '';
    if (!tracks.length) return html + (miss.length ? '' : emptyState('note', 'Playlist vide', 'Ajoute des morceaux avec « Ajouter » ou depuis le menu ••• d’un titre.')) + missHtml;
    html += tracks
      .map((t, i) =>
        trackRow(t, 'pl', i, {
          index: !ui.plEdit,
          ctx: `data-pl="${p.id}" data-pli="${i}"`,
          side: ui.plEdit
            ? `<div class="side"><button class="icon-btn" data-act="pl-move" data-id="${p.id}" data-i="${i}" data-d="-1" ${i ? '' : 'disabled'}>${icon('up', 20)}</button><button class="icon-btn" data-act="pl-move" data-id="${p.id}" data-i="${i}" data-d="1" ${i < tracks.length - 1 ? '' : 'disabled'}>${icon('down', 20)}</button><button class="icon-btn" style="color:var(--danger)" data-act="pl-remove" data-id="${p.id}" data-i="${i}">${icon('minusCircle', 22)}</button></div>`
            : null,
        }),
      )
      .join('');
    return html + missHtml;
  },

  favorites() {
    const list = S.state.favorites.map(S.getTrack).filter(Boolean);
    lists.fav = list.map((t) => t.id);
    const dur = list.reduce((a, t) => a + (t.duration || 0), 0);
    let html = backBar() + `<h1 class="title pad" style="margin-bottom:8px">Favoris</h1>`;
    if (!list.length) return html + emptyState('heart', 'Aucun favori', 'Touche le cœur dans le lecteur ou dans le menu d’un morceau pour le retrouver ici.');
    html += `<p class="muted pad" style="margin-bottom:12px">${plural(list.length, 'titre aimé', 'titres aimés')}${dur ? ' · ' + fmtLong(dur) : ''}</p>
      <div class="btns"><button class="btn grad sm" data-act="play" data-play="fav:0" data-noshuffle="1">${icon('play', 16)}Lire</button><button class="btn ghost sm" data-act="shuffle-list" data-list="fav">${icon('shuffle', 16)}Aléatoire</button></div>`;
    return html + list.map((t, i) => trackRow(t, 'fav', i)).join('');
  },

  history() {
    let html = backBar(S.state.history.length ? `<button class="icon-btn" data-act="clear-history" aria-label="Effacer">${icon('trash', 22)}</button>` : '') + `<h1 class="title pad" style="margin-bottom:8px">Historique</h1>`;
    const items = S.state.history.slice(0, 400).filter((h) => S.getTrack(h.trackId));
    if (!items.length) return html + emptyState('clock', 'Pas encore d’écoute', 'Les morceaux que tu écoutes apparaîtront ici.');
    const today = new Date().toDateString();
    const yest = new Date(Date.now() - 86400000).toDateString();
    let lastDay = '';
    items.forEach((h, i) => {
      const d = new Date(h.at);
      const label = d.toDateString() === today ? 'Aujourd’hui' : d.toDateString() === yest ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      if (label !== lastDay) {
        html += `<h3 style="font-size:17px;font-weight:800;padding:18px 16px 6px;text-transform:capitalize">${label}</h3>`;
        lastDay = label;
      }
      lists['h' + i] = [h.trackId];
      html += trackRow(S.getTrack(h.trackId), 'h' + i, 0, { side: `<span class="faint" style="font-size:12px">${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>` });
    });
    return html;
  },

  stats() {
    const { playCounts: pc, listenSeconds: ls, history } = S.state;
    let html = backBar(`<button class="icon-btn" data-act="reset-stats" aria-label="Réinitialiser">${icon('trash', 22)}</button>`) + `<h1 class="title pad" style="margin-bottom:8px">Statistiques</h1>`;
    const plays = Object.values(pc).reduce((a, b) => a + b, 0);
    if (!plays) return html + emptyState('stats', 'Pas encore de statistiques', 'Écoute quelques morceaux : tes tendances apparaîtront ici. Tout reste sur ton téléphone.');
    const secs = Object.values(ls).reduce((a, b) => a + b, 0);
    const top = Object.entries(pc).filter(([id]) => S.getTrack(id)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    lists.topstats = top.map(([id]) => id);
    const by = (f) => {
      const m = new Map();
      Object.entries(ls).forEach(([id, s]) => {
        const t = S.getTrack(id);
        const k = t && f(t);
        if (k) m.set(k, (m.get(k) || 0) + s);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    };
    const bars = (items) => {
      const max = Math.max(1, ...items.map((x) => x[1]));
      return `<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:12px;margin:0 16px">${items
        .map(([n, s]) => `<div><div class="row-between"><b style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</b><span class="muted" style="font-size:12px">${fmtLong(s)}</span></div><div class="meter" style="height:6px;margin-top:5px"><div style="width:${(s / max) * 100}%"></div></div></div>`)
        .join('')}</div>`;
    };
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const s = d.getTime();
      days.push({ l: d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''), n: history.filter((h) => h.at >= s && h.at < s + 86400000).length });
    }
    const maxD = Math.max(1, ...days.map((d) => d.n));
    const hours = new Array(24).fill(0);
    history.forEach((h) => hours[new Date(h.at).getHours()]++);
    html += `<div style="display:flex;gap:10px;padding:0 16px"><div class="stat-big" style="flex:1.4"><b>${fmtLong(secs)}</b><span style="font-size:12px;opacity:.85">d’écoute</span></div>
      <div class="card" style="flex:1;padding:12px;display:flex;flex-direction:column;justify-content:flex-end"><b style="font-size:22px">${plays}</b><span class="muted" style="font-size:12px">lectures</span></div>
      <div class="card" style="flex:1;padding:12px;display:flex;flex-direction:column;justify-content:flex-end"><b style="font-size:22px">${S.state.tracks.size}</b><span class="muted" style="font-size:12px">morceaux</span></div></div>`;
    html += section('7 derniers jours', `<div class="card chart" style="margin:0 16px">${days.map((d) => `<div class="col"><b>${d.n || ''}</b><div class="bar" style="height:${Math.max(4, (d.n / maxD) * 90)}px;opacity:${d.n ? 1 : 0.25}"></div><span style="text-transform:capitalize">${d.l}</span></div>`).join('')}</div>${history.length ? `<p class="muted pad" style="margin-top:8px">Tu écoutes le plus vers ${hours.indexOf(Math.max(...hours))} h.</p>` : ''}`);
    if (top.length)
      html += section(
        'Morceaux les plus écoutés',
        `<div class="card" style="margin:0 16px;padding:6px 0">${top
          .map(([id, n], i) => {
            const t = S.getTrack(id);
            return `<div class="trow" data-act="play" data-play="topstats:${i}"><b style="color:var(--a);width:22px">${i + 1}</b>${art(t.artKey, t.album + t.artist, 40, { radius: 8 })}<div class="meta"><div class="t" style="font-size:15px">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div><span class="muted" style="font-size:12px">${n}×</span></div>`;
          })
          .join('')}</div>`,
      );
    const ar = by((t) => t.artist);
    if (ar.length) html += section('Artistes préférés', bars(ar));
    const ge = by((t) => t.genre);
    if (ge.length) html += section('Genres', bars(ge));
    return html;
  },

  track(id) {
    const t = S.getTrack(id);
    if (!t) return backBar() + emptyState('note', 'Morceau introuvable');
    const f = (k, l, ph = '') => `<div><label class="lbl" for="f-${k}">${l}</label><input class="field" id="f-${k}" value="${esc(t[k])}" placeholder="${ph}" autocomplete="off" /></div>`;
    return `${backBar(`<button class="link" style="padding:8px 12px;font-size:16px" data-act="save-track" data-id="${t.id}">OK</button>`)}
      <div style="padding:8px 20px;display:flex;flex-direction:column;gap:16px">
        <button data-act="track-art" data-id="${t.id}" style="align-self:center;position:relative">${art(t.artKey, t.album + t.artist, 180, { radius: 18, cls: 'shadow' })}<span class="cam" style="right:-6px;bottom:-6px;background:var(--a)">${icon('image', 16)}</span></button>
        ${t.artKey ? `<div style="display:flex;gap:10px;justify-content:center"><button class="btn ghost sm" data-act="track-art-remove" data-id="${t.id}">${icon('trash', 16)}Retirer</button><button class="btn ghost sm" data-act="track-art-album" data-id="${t.id}">${icon('disc', 16)}Appliquer à l’album</button></div>` : ''}
        ${f('title', 'Titre')}${f('artist', 'Artiste')}${f('album', 'Album')}${f('genre', 'Genre', 'Ex. Rap, Pop, Rock…')}
        <div class="card" style="padding:14px;display:flex;flex-direction:column;gap:4px"><p class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Fichier : ${esc(t.fileName)}</p><p class="muted">Durée : ${fmtTime(t.duration)} · Taille : ${fmtBytes(t.size)}</p><p class="muted">Ajouté le ${new Date(t.addedAt).toLocaleDateString('fr-FR')}</p></div>
        <button class="btn grad block" data-act="save-track" data-id="${t.id}">${icon('check', 18)}Enregistrer</button>
        <button class="btn ghost block" style="color:var(--danger)" data-act="delete-tracks" data-id="${t.id}">${icon('trash', 18)}Supprimer ce morceau</button>
      </div>`;
  },

  settings() {
    const st = S.state.settings;
    const accents = { aurora: ['Aurore', '#8b5cff', '#ff5e8a'], ocean: ['Océan', '#2e7bff', '#20d8c4'], sunset: ['Couchant', '#ff7a45', '#ffc145'], forest: ['Forêt', '#1db954', '#b6f04a'], mono: ['Mono', '#8a8a99', '#c9c9d4'] };
    const row = (ic, label, attrs = '', right = icon('right', 18), cls = '') => `<button class="srow ${cls}" ${attrs}><span class="si">${icon(ic, 18)}</span><span class="grow">${label}</span><span class="faint">${right}</span></button>`;
    return `<h1 class="title pad">Réglages</h1>
      <div class="group-t">APPARENCE</div><div class="group">
        <div class="seg">${[['system', 'Auto', 'phone'], ['dark', 'Sombre', 'moon'], ['light', 'Clair', 'sun']].map(([k, l, ic]) => `<button class="${st.theme === k ? 'on' : ''}" data-act="theme" data-k="${k}">${icon(ic, 16)}${l}</button>`).join('')}</div>
        <p class="muted" style="padding:0 14px 10px;font-size:13px;font-weight:600">Couleur d’accent</p>
        <div class="swatches">${Object.entries(accents).map(([k, [n, a, b]]) => `<button class="swatch ${st.accent === k ? 'on' : ''}" data-act="accent" data-k="${k}"><i style="background:linear-gradient(135deg,${a},${b})">${st.accent === k ? icon('check', 20) : ''}</i>${n}</button>`).join('')}</div>
      </div>
      <div class="group-t">LECTURE</div><div class="group">
        ${row('repeat', 'Reprendre la dernière écoute', 'data-act="toggle-resume"', `<span class="switch ${st.autoResume ? 'on' : ''}"></span>`)}
        ${row('stats', 'Statistiques', 'data-go="#/stats"')}
        ${row('clock', 'Historique d’écoute', 'data-go="#/history"')}
      </div>
      <div class="group-t">BIBLIOTHÈQUE ET STOCKAGE</div><div class="group">
        ${row('import', ui.importing ? 'Import en cours…' : 'Importer des musiques', 'data-act="import"')}
        ${row('note', 'Morceaux', '', String(S.state.tracks.size))}
        ${row('playlists', 'Playlists', '', String(S.state.playlists.length))}
        <div style="padding:14px" id="storage"><p class="muted">Calcul de l’espace…</p></div>
        ${row('trash', 'Tout supprimer', 'data-act="wipe"', '', 'danger')}
      </div>
      <div class="group-t">SAUVEGARDE DES PLAYLISTS</div><div class="group">
        ${row('share', 'Exporter playlists et favoris', 'data-act="export"')}
        ${row('import', 'Restaurer une sauvegarde', 'data-act="restore"')}
        <p class="muted" style="font-size:12px;padding:4px 14px 14px">La sauvegarde contient la liste des titres (pas les fichiers audio). Les morceaux sont retrouvés par nom de fichier ou titre + artiste.</p>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px 16px 0">
        <div class="wordmark" style="font-size:16px"><div class="logo" style="width:22px;height:22px"><i style="height:7px"></i><i style="height:12px"></i><i style="height:9px"></i></div>SONORA</div>
        <p class="muted" style="text-align:center;font-size:12px;line-height:1.5">Version 1.0 · Sans publicité · Sans abonnement · Sans compte<br>Aucune donnée ne quitte ton téléphone.</p>
      </div>`;
  },
};

/* ============================ RECHERCHE (live) ========================== */
function renderSearchResults() {
  const box = $('#results');
  if (!box) return;
  const all = S.allTracks();
  const q = normalize(ui.q);
  if (!q) {
    const g = new Map();
    all.forEach((t) => t.genre && g.set(t.genre, (g.get(t.genre) || 0) + 1));
    const genres = [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    box.innerHTML = genres.length
      ? `<h2 class="pad" style="font-size:19px;font-weight:800;margin-bottom:12px">Parcourir par genre</h2><div class="genres">${genres
          .map(([n, c]) => {
            const [a, b] = hashColors(n);
            return `<button class="genre" style="background:linear-gradient(135deg,${a},${b})" data-act="genre" data-v="${esc(n)}"><b>${esc(n)}</b><span>${plural(c, 'titre')}</span></button>`;
          })
          .join('')}</div>`
      : emptyState('search', 'Cherche dans ta musique', 'La recherche porte sur ta bibliothèque, sans connexion Internet.');
    return;
  }
  const words = q.split(/\s+/);
  const scored = [];
  for (const t of all) {
    const f = { title: normalize(t.title), artist: normalize(t.artist), album: normalize(t.album), genre: normalize(t.genre) };
    const hay = ui.field === 'all' ? `${f.title} ${f.artist} ${f.album} ${f.genre}` : f[ui.field];
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ t, s: (f.title.startsWith(q) ? 5 : 0) + (f.artist.startsWith(q) ? 4 : 0) + (f.title.includes(q) ? 2 : 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  const res = scored.map((x) => x.t);
  lists.search = res.map((t) => t.id);
  const pls = ui.field === 'all' ? S.state.playlists.filter((p) => normalize(p.name).includes(q)) : [];
  box.innerHTML =
    pls.map((p) => `<button class="list-row" style="width:100%;text-align:left" data-go="#/playlist/${p.id}">${art(p.imageKey, p.id, 50, { radius: 10, ic: 'playlists' })}<div><div class="t">${esc(p.name)}</div><div class="muted" style="font-size:13px">Playlist · ${plural(p.trackIds.length, 'titre')}</div></div></button>`).join('') +
    `<p class="muted pad" style="padding-bottom:6px">${plural(res.length, 'résultat')}</p>` +
    (res.length ? res.map((t, i) => trackRow(t, 'search', i)).join('') : emptyState('search', 'Aucun résultat', `Rien ne correspond à « ${ui.q} ».`));
  hydrateArt(box);
}

/* ============================== MINI LECTEUR ============================ */
const mini = $('#mini');
function renderMini() {
  const t = P.current;
  mini.classList.toggle('hidden', !t || ui.playerOpen);
  if (!t) return;
  const artEl = $('.mini-art', mini);
  const k = (t.artKey || '') + t.id;
  if (artEl.dataset.k !== k) {
    artEl.innerHTML = art(t.artKey, t.album + t.artist, 42, { radius: 8 });
    artEl.dataset.k = k;
    hydrateArt(artEl);
  }
  $('.mini-title', mini).textContent = t.title;
  $('.mini-artist', mini).textContent = t.artist;
  $('[data-act="toggle"]', mini).innerHTML = icon(P.playing ? 'pause' : 'play', 26);
  $('[data-act="next"]', mini).innerHTML = icon('next', 22);
}
onProgress(() => {
  const d = P.duration;
  $('.mini-progress div', mini).style.width = (d ? Math.min(100, (P.position / d) * 100) : 0) + '%';
  if (ui.playerOpen) updatePlayerProgress();
});

/* ============================ LECTEUR PLEIN ÉCRAN ======================= */
const player = $('#player');
let seeking = false;
function openPlayer() {
  if (!P.current) return;
  ui.playerOpen = true;
  renderPlayer(true);
  player.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => player.classList.add('open'));
  renderMini();
}
function closePlayer() {
  ui.playerOpen = false;
  player.classList.remove('open');
  player.setAttribute('aria-hidden', 'true');
  renderMini();
}
function renderPlayer(force) {
  const t = P.current;
  if (!t) return closePlayer();
  const fav = S.isFav(t.id);
  const key = t.id + (t.artKey || '') + t.title + t.artist + t.album + (t.artVer || '');
  if (force || player.dataset.k !== key) {
    player.dataset.k = key;
    const [c1, c2] = hashColors(t.album + t.artist);
    player.innerHTML = `<div class="bgimg" id="pbg" style="background-image:linear-gradient(135deg,${c1},${c2})"></div><div class="shade"></div>
      <div class="inner">
        <div class="top"><button class="icon-btn" data-act="close-player" aria-label="Fermer">${icon('down', 28)}</button>
          <div class="mid"><div class="k">EN LECTURE</div><div class="al">${esc(t.album)}</div></div>
          <button class="icon-btn" data-act="more" data-id="${t.id}" aria-label="Options">${icon('more', 24)}</button></div>
        <div class="stage"><div class="big-art">${art(t.artKey, t.album + t.artist, 300, { radius: 22 })}</div></div>
        <div class="meta"><div style="flex:1;min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
          <button class="icon-btn fav" data-act="fav" data-id="${t.id}" aria-label="Favori"></button></div>
        <input type="range" class="range seek" id="seek" min="0" max="1000" value="0" aria-label="Position" />
        <div class="times"><span id="tpos">0:00</span><span id="tleft">-0:00</span></div>
        <div class="controls">
          <button class="icon-btn" data-act="p-shuffle" aria-label="Aléatoire">${icon('shuffle', 24)}</button>
          <button class="icon-btn" data-act="p-prev" aria-label="Précédent">${icon('prev', 36)}</button>
          <button class="play-main" data-act="p-toggle" aria-label="Lecture/Pause"></button>
          <button class="icon-btn" data-act="p-next" aria-label="Suivant">${icon('next', 36)}</button>
          <button class="icon-btn" data-act="p-repeat" aria-label="Répéter">${icon('repeat', 24)}</button>
        </div>
        ${
          isIOS
            ? `<div class="vol-note">Volume : boutons latéraux de l’iPhone</div>`
            : `<div class="vol">${icon('volLow', 18)}<input type="range" class="range" id="vol" min="0" max="100" value="${Math.round(P.volume * 100)}" style="--p:${P.volume * 100}%" aria-label="Volume" />${icon('volHigh', 20)}</div>`
        }
        <div class="pbottom"><button data-act="sleep" id="sleep-btn">${icon('moon', 20)}<span>Minuteur</span></button><button data-act="queue">${icon('queue', 22)}<span>File d’attente</span></button></div>
      </div>`;
    if (t.artKey)
      S.blobUrl(t.artKey).then((u) => {
        if (!u) return;
        $('#pbg', player).style.backgroundImage = `url("${u}")`;
      });
    hydrateArt(player);
    const seek = $('#seek', player);
    seek.addEventListener('input', () => {
      seeking = true;
      const s = (seek.value / 1000) * P.duration;
      seek.style.setProperty('--p', seek.value / 10 + '%');
      $('#tpos', player).textContent = fmtTime(s);
    });
    seek.addEventListener('change', () => {
      Player.seek((seek.value / 1000) * P.duration);
      seeking = false;
    });
    const vol = $('#vol', player);
    vol?.addEventListener('input', () => {
      Player.setVolume(vol.value / 100);
      vol.style.setProperty('--p', vol.value + '%');
    });
  }
  player.classList.toggle('paused', !P.playing);
  const favBtn = $('.fav', player);
  favBtn.classList.toggle('on', fav);
  favBtn.innerHTML = icon(fav ? 'heart' : 'heartOutline', 28);
  $('[data-act="p-toggle"]', player).innerHTML = icon(P.playing ? 'pause' : 'play', 36);
  $('[data-act="p-shuffle"]', player).classList.toggle('on', P.shuffle);
  const rep = $('[data-act="p-repeat"]', player);
  rep.classList.toggle('on', P.repeat !== 'off');
  rep.classList.toggle('repeat-one', P.repeat === 'one');
  const sb = $('#sleep-btn', player);
  sb.classList.toggle('on', !!(P.sleepAt || P.sleepEnd));
  $('span', sb).textContent = P.sleepEnd ? 'Fin du morceau' : P.sleepAt ? fmtTime((P.sleepAt - Date.now()) / 1000) : 'Minuteur';
  updatePlayerProgress();
}
function updatePlayerProgress() {
  const d = P.duration;
  const pos = P.position;
  if (!seeking) {
    const seek = $('#seek', player);
    if (seek) {
      const v = d ? Math.round((pos / d) * 1000) : 0;
      seek.value = v;
      seek.style.setProperty('--p', v / 10 + '%');
    }
    const tp = $('#tpos', player);
    if (tp) tp.textContent = fmtTime(pos);
  }
  const tl = $('#tleft', player);
  if (tl) tl.textContent = '-' + fmtTime(Math.max(0, d - pos));
}
setInterval(() => ui.playerOpen && (P.sleepAt || P.sleepEnd) && renderPlayer(), 1000);

/* ================================ FEUILLES =============================== */
function trackSheet(id, ctx = {}) {
  const t = S.getTrack(id);
  if (!t) return;
  const fav = S.isFav(id);
  const item = (act, ic, label, danger) => `<button class="sitem ${danger ? 'danger' : ''}" data-s="${act}">${icon(ic, 22)}${label}</button>`;
  openSheet(
    `<div class="sheet-head">${art(t.artKey, t.album + t.artist, 56, { radius: 10 })}<div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)} · ${esc(t.album)}</div></div></div>
    ${item('next', 'playNext', 'Lire ensuite')}${item('queue', 'queue', 'Ajouter à la file d’attente')}${item('pl', 'plusCircle', 'Ajouter à une playlist')}
    ${item('fav', fav ? 'heart' : 'heartOutline', fav ? 'Retirer des favoris' : 'Ajouter aux favoris')}${item('edit', 'edit', 'Modifier les infos et la pochette')}
    ${ctx.pl ? item('plremove', 'close', 'Retirer de cette playlist') : ''}${item('del', 'trash', 'Supprimer de la bibliothèque', true)}`,
    (el, close) =>
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-s]')?.dataset.s;
        if (!a) return;
        if (a === 'next') (Player.playNext([id]), toast('Sera lu ensuite'), close());
        if (a === 'queue') (Player.addToQueue([id]), toast('Ajouté à la file'), close());
        if (a === 'pl') addToPlaylistSheet([id]);
        if (a === 'fav') (toast(S.toggleFav(id) ? 'Ajouté aux favoris' : 'Retiré des favoris'), close());
        if (a === 'edit') (close(), closePlayer(), (location.hash = '#/track/' + id));
        if (a === 'plremove') (S.removeFromPlaylist(ctx.pl, +ctx.pli), toast('Retiré de la playlist'), close());
        if (a === 'del') (close(), deleteTracks([id]));
      }),
  );
}

function addToPlaylistSheet(ids) {
  const pls = S.state.playlists;
  openSheet(
    `<div class="dlg"><h3>Ajouter ${ids.length > 1 ? plural(ids.length, 'morceau', 'morceaux') + ' ' : ''}à une playlist</h3>
      <div style="display:flex;gap:8px"><input class="field" id="newpl" placeholder="Nouvelle playlist…" /><button class="btn grad sm" data-s="create">${icon('plus', 16)}Créer</button></div></div>
      ${pls.map((p) => `<button class="pick-row" style="width:100%;text-align:left" data-s="add" data-id="${p.id}">${art(p.imageKey, p.id, 44, { radius: 8, ic: 'playlists' })}<div style="flex:1;min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div><div class="muted" style="font-size:12px">${plural(p.trackIds.length, 'titre')}</div></div><span class="on">${icon('plus', 22)}</span></button>`).join('') || '<p class="muted pad" style="padding:12px 16px">Aucune playlist pour l’instant.</p>'}`,
    (el, close) =>
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-s]');
        if (!b) return;
        if (b.dataset.s === 'create') {
          const name = $('#newpl', el).value.trim() || 'Nouvelle playlist';
          S.createPlaylist(name, ids);
          toast(`Playlist « ${name} » créée`);
          ui.selection = null;
          close();
        } else {
          const p = S.getPlaylist(b.dataset.id);
          toast(S.addToPlaylist(p.id, ids) ? `Ajouté à « ${p.name} »` : `Déjà dans « ${p.name} »`);
          ui.selection = null;
          close();
        }
      }),
  );
}

function queueSheet() {
  const draw = (el) => {
    const cur = P.current;
    const up = P.queue.slice(P.index + 1);
    lists.queue = P.queue;
    el.querySelector('.sheet-body').innerHTML = `<div class="row-between" style="padding:0 8px 0 16px"><h3>File d’attente</h3><div style="display:flex">${up.length ? `<button class="icon-btn" data-q="clear" aria-label="Vider">${icon('trash', 22)}</button>` : ''}<button class="icon-btn" data-q="close" aria-label="Fermer">${icon('close', 22)}</button></div></div>
      ${cur ? `<p class="muted pad" style="font-size:12px;font-weight:800;letter-spacing:1.2px;padding-top:12px">EN COURS</p>${trackRow(cur, 'queue', P.index, { side: '' })}` : ''}
      <p class="muted pad" style="font-size:12px;font-weight:800;letter-spacing:1.2px;padding-top:16px">À SUIVRE · ${up.length}${P.shuffle ? ' · aléatoire' : ''}</p>
      ${up.length ? up.map((id, i) => {
        const real = P.index + 1 + i;
        const t = S.getTrack(id);
        return t ? trackRow(t, 'queue', real, { side: `<div class="side"><button class="icon-btn" data-q="up" data-i="${real}" ${i ? '' : 'disabled'}>${icon('up', 18)}</button><button class="icon-btn" data-q="down" data-i="${real}" ${real < P.queue.length - 1 ? '' : 'disabled'}>${icon('down', 18)}</button><button class="icon-btn" data-q="rm" data-i="${real}">${icon('close', 18)}</button></div>` }).replace('data-act="play" data-play', 'data-q="jump" data-play') : '';
      }).join('') : '<p class="muted pad">Plus rien après ce morceau.</p>'}`;
    hydrateArt(el);
  };
  const el = openSheet('', (el, close) => {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      const i = +b.dataset.i;
      const q = b.dataset.q;
      if (q === 'close') return close();
      if (q === 'clear') Player.clearQueue();
      if (q === 'rm') Player.removeFromQueue(i);
      if (q === 'up') Player.moveInQueue(i, i - 1);
      if (q === 'down') Player.moveInQueue(i, i + 1);
      if (q === 'jump') Player.jumpTo(+b.dataset.play.split(':')[1]);
      setTimeout(() => draw(el), 30);
    });
  });
  draw(el);
}

function sleepSheet() {
  const opts = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 heure'], [90, '1 h 30'], ['end', 'Fin du morceau']];
  openSheet(
    `<div class="dlg" style="padding-bottom:0"><h3>Minuteur de sommeil</h3></div>${opts.map(([v, l]) => `<button class="sitem" data-v="${v}">${l}</button>`).join('')}${P.sleepAt || P.sleepEnd ? `<button class="sitem danger" data-v="off">Désactiver le minuteur</button>` : ''}`,
    (el, close) =>
      el.addEventListener('click', (e) => {
        const v = e.target.closest('[data-v]')?.dataset.v;
        if (!v) return;
        if (v === 'off') (Player.setSleep(null), toast('Minuteur désactivé'));
        else (Player.setSleep(v === 'end' ? 'end' : +v), toast(v === 'end' ? 'Pause à la fin du morceau' : `Pause dans ${opts.find((o) => String(o[0]) === v)[1]}`));
        close();
        renderPlayer();
      }),
  );
}

function plAddSheet(pid) {
  const p = S.getPlaylist(pid);
  const picked = new Set();
  const draw = (el, filter = '') => {
    const n = normalize(filter);
    const cands = S.allTracks()
      .filter((t) => !p.trackIds.includes(t.id) && (!n || normalize(`${t.title} ${t.artist} ${t.album}`).includes(n)))
      .sort((a, b) => compareFr(a.title, b.title));
    $('#cands', el).innerHTML = cands.length
      ? cands.map((t) => `<button class="pick-row" style="width:100%;text-align:left" data-t="${t.id}">${art(t.artKey, t.album + t.artist, 42, { radius: 8 })}<div style="flex:1;min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div><div class="muted" style="font-size:12px">${esc(t.artist)}</div></div><span class="${picked.has(t.id) ? 'on' : 'faint'}">${icon(picked.has(t.id) ? 'checkCircle' : 'circle', 24)}</span></button>`).join('')
      : '<p class="muted pad" style="padding:16px">Tous tes morceaux sont déjà dans cette playlist.</p>';
    $('#addbtn', el).textContent = picked.size ? `Ajouter ${plural(picked.size, 'morceau', 'morceaux')}` : 'Choisis des morceaux';
    hydrateArt(el);
  };
  const el = openSheet(
    `<div class="dlg"><h3>Ajouter des morceaux</h3><input class="field" id="flt" placeholder="Filtrer…" autocomplete="off" /></div>
     <div id="cands"></div><div style="padding:8px 16px 0;position:sticky;bottom:0;background:var(--bg2)"><button class="btn grad block" id="addbtn"></button></div>`,
    (el, close) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-t]');
        if (b) {
          const id = b.dataset.t;
          picked.has(id) ? picked.delete(id) : picked.add(id);
          draw(el, $('#flt', el).value);
        }
        if (e.target.closest('#addbtn') && picked.size) {
          S.addToPlaylist(pid, [...picked]);
          toast('Ajouté à la playlist');
          close();
        }
      });
      $('#flt', el).addEventListener('input', (e) => draw(el, e.target.value));
    },
  );
  draw(el);
}

/* ======================= IMPORT DE PLAYLIST EXTERNE ======================= */
function importPlaylistSheet(prefill = '') {
  openSheet(
    `<div class="dlg">
      <h3>Importer une playlist</h3>
      <p class="muted" style="line-height:1.45">SONORA récupère la <b>liste des titres</b> et les retrouve dans ta bibliothèque. Aucune musique n’est téléchargée : les titres absents restent « en attente » jusqu’à ce que tu importes leurs fichiers.</p>
      <label class="lbl" for="pl-link" style="margin-bottom:-8px">Lien de la playlist Deezer</label>
      <input class="field" id="pl-link" placeholder="https://www.deezer.com/fr/playlist/…" value="${esc(prefill)}" autocomplete="off" autocapitalize="off" inputmode="url" />
      <button class="btn grad block" data-i="link">${icon('import', 18)}Importer depuis le lien</button>
      <div id="pl-msg"></div>
      <div style="height:1px;background:var(--border);margin:4px 0"></div>
      <button class="btn ghost block" data-i="csv">${icon('share', 18)}Fichier CSV (Spotify, TuneMyMusic…)</button>
      <button class="btn ghost block" data-i="text">${icon('edit', 18)}Coller une liste de titres</button>
    </div>`,
    (el, close) => {
      const msg = (h) => ($('#pl-msg', el).innerHTML = h);
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-i]');
        if (!b) return;
        if (b.dataset.i === 'csv') {
          const f = await pickFile('csv-input');
          if (!f) return;
          try {
            close();
            finishImport(IMP.parseCsv(await f[0].text(), f[0].name));
          } catch (err) {
            dialog({ title: 'Fichier non reconnu', text: err.message, ok: 'OK', cancel: 'Fermer' });
          }
          return;
        }
        if (b.dataset.i === 'text') return textImportSheet();
        if (b.dataset.i === 'spotify-help') return spotifyHelp(msg);
        // Lien
        const link = $('#pl-link', el).value.trim();
        const info = IMP.parseLink(link);
        if (!link) return msg(`<p class="muted">Colle d’abord le lien de ta playlist.</p>`);
        if (!info) return msg(`<p class="muted" style="color:var(--danger)">Lien non reconnu. Exemple : https://www.deezer.com/fr/playlist/123456</p>`);
        if (info.service === 'spotify') return spotifyHelp(msg);
        if (info.service === 'deezer-short')
          return msg(`<p class="muted" style="line-height:1.45">C’est un lien court Deezer. Ouvre-le dans Safari : la page Deezer s’affiche avec une adresse du type <b>deezer.com/fr/playlist/123456</b>. Copie cette adresse complète (ou juste le numéro) et colle-la ici.</p>`);
        if (info.service === 'other') return msg(`<p class="muted" style="line-height:1.45">Ce service n’est pas encore pris en charge par lien. Exporte ta playlist en CSV (par ex. avec TuneMyMusic) puis utilise « Fichier CSV ».</p>`);
        b.disabled = true;
        b.innerHTML = `${icon('import', 18)}Récupération…`;
        try {
          const list = await IMP.fetchDeezer(info, (n, total) => (b.innerHTML = `${icon('import', 18)}${n} / ${total} titres…`));
          close();
          finishImport(list);
        } catch (err) {
          b.disabled = false;
          b.innerHTML = `${icon('import', 18)}Importer depuis le lien`;
          msg(`<p class="muted" style="color:var(--danger);line-height:1.45">${esc(err.message)}</p>`);
        }
      });
    },
  );
}

function spotifyHelp(msg) {
  msg(`<div class="card" style="padding:14px;line-height:1.5;font-size:14px">
    <b>Spotify bloque la lecture des playlists par lien</b> pour les applications indépendantes (règles de février 2026). Passe par un export CSV, ça prend 1 minute :
    <ol style="padding-left:20px;margin:8px 0">
      <li>Ouvre <b>exportify.app</b> et connecte-toi à Spotify.</li>
      <li>Touche <b>Export</b> à côté de ta playlist : un fichier .csv est enregistré dans l’app Fichiers.</li>
      <li>Reviens ici et touche <b>Fichier CSV</b>.</li>
    </ol>
    <span class="muted">Fonctionne avec les playlists que tu as créées toi-même.</span></div>`);
}

function textImportSheet() {
  openSheet(
    `<div class="dlg"><h3>Coller une liste</h3>
      <p class="muted" style="line-height:1.45">Une ligne par titre, de préférence sous la forme <b>Artiste - Titre</b>.</p>
      <input class="field" id="tx-name" placeholder="Nom de la playlist" autocomplete="off" />
      <textarea class="field" id="tx-list" rows="8" placeholder="Stromae - Alors on danse&#10;Daft Punk - One More Time" style="resize:vertical"></textarea>
      <button class="btn grad block" data-t="go">${icon('check', 18)}Créer la playlist</button></div>`,
    (el, close) =>
      el.addEventListener('click', (e) => {
        if (!e.target.closest('[data-t="go"]')) return;
        const list = IMP.parseText($('#tx-list', el).value);
        if (!list.tracks.length) return toast('La liste est vide');
        list.name = $('#tx-name', el).value.trim() || 'Playlist importée';
        close();
        finishImport(list);
      }),
  );
}

async function finishImport(list) {
  if (!list.tracks.length) return dialog({ title: 'Playlist vide', text: 'Aucun titre trouvé dans cette playlist.', ok: 'OK', cancel: 'Fermer' });
  const r = IMP.createFromImport(list);
  location.hash = '#/playlist/' + r.id;
  await new Promise((ok) => setTimeout(ok, 120)); // laisse la navigation se faire avant d'ouvrir le message
  await dialog({
    title: `« ${list.name} » importée`,
    text:
      `${r.found} titre${r.found > 1 ? 's' : ''} sur ${r.total} trouvé${r.found > 1 ? 's' : ''} dans ta bibliothèque.` +
      (r.missing ? ` ${r.missing} en attente : importe leurs fichiers et ils s’ajouteront automatiquement à la playlist.` : ' Tout est prêt !'),
    ok: r.found ? 'Écouter' : 'OK',
    cancel: 'Fermer',
  }).then((v) => v && r.found && Player.playList(S.getPlaylist(r.id).trackIds, 0, { shuffle: false }));
}

async function deleteTracks(ids, after) {
  const ok = await dialog({
    title: ids.length > 1 ? `Supprimer ${ids.length} morceaux ?` : 'Supprimer ce morceau ?',
    text: 'Le fichier est effacé de SONORA et retiré de tes playlists. L’original dans l’app Fichiers n’est pas touché.',
    ok: 'Supprimer',
    danger: true,
  });
  if (!ok) return;
  Player.forget(ids);
  await S.removeTracks(ids);
  toast(ids.length > 1 ? `${ids.length} morceaux supprimés` : 'Morceau supprimé');
  after?.();
}

async function doImport() {
  if (ui.importing) return;
  const files = await pickFile('file-input');
  if (!files) return;
  requestPersistence();
  ui.importing = { done: 0, total: files.length };
  render();
  const res = await S.importFiles(files, (done, total, name) => {
    ui.importing = { done, total, name };
    S.emit();
  });
  ui.importing = null;
  const filled = res.imported ? IMP.fillMissing() : 0;
  const parts = [];
  if (res.imported) parts.push(`${res.imported} importé${res.imported > 1 ? 's' : ''}`);
  if (res.duplicates) parts.push(`${res.duplicates} déjà présent${res.duplicates > 1 ? 's' : ''}`);
  if (res.skipped.length) parts.push(`${res.skipped.length} ignoré${res.skipped.length > 1 ? 's' : ''}`);
  if (filled) parts.push(`${filled} ajouté${filled > 1 ? 's' : ''} à tes playlists`);
  toast(parts.join(' · ') || 'Aucun fichier importé');
  if (res.skipped.length) dialog({ title: 'Certains fichiers ont été ignorés', text: 'Formats acceptés : MP3, WAV, FLAC, AAC, M4A, OGG.\n' + res.skipped.slice(0, 6).join(', '), ok: 'OK', cancel: 'Fermer' });
  S.emit();
}

/* ================================ ACTIONS =============================== */
const ACTS = {
  play(el) {
    const [name, i] = el.dataset.play.split(':');
    const ids = lists[name];
    if (!ids) return;
    Player.playList(ids, +i, el.dataset.noshuffle ? { shuffle: false } : {});
  },
  'shuffle-all': () => Player.playList(S.allTracks().map((t) => t.id), 0, { shuffle: true }),
  'shuffle-list': (el) => Player.playList(lists[el.dataset.list] || [], 0, { shuffle: true }),
  resume: () => (Player.play(), openPlayer()),
  more: (el) => trackSheet(el.dataset.id, { pl: el.dataset.pl, pli: el.dataset.pli }),
  import: doImport,
  back: () => (history.length > 1 ? history.back() : (location.hash = '#/')),
  'hide-hint': () => (localStorage.setItem('sonora-hint', '1'), (ui.hintClosed = true), render()),
  'clear-q': () => ((ui.q = ''), (lastRouteKey = ''), render()),
  field: (el) => ((ui.field = el.dataset.k), document.querySelectorAll('[data-act="field"]').forEach((c) => c.classList.toggle('on', c === el)), renderSearchResults()),
  genre: (el) => ((ui.q = el.dataset.v), (ui.field = 'genre'), (lastRouteKey = ''), render()),
  libview: (el) => ((ui.libView = el.dataset.k), (ui.libFilter = null), render()),
  libfilter: (el) => ((ui.libFilter = { type: el.dataset.type, v: el.dataset.v }), (view.scrollTop = 0), render()),
  'libfilter-clear': () => ((ui.libFilter = null), render()),
  sort: (el) => S.setSettings({ sortKey: el.dataset.k }),
  'sort-dir': () => S.setSettings({ sortDesc: !S.state.settings.sortDesc }),
  'select-mode': () => ((ui.selection = ui.selection ? null : new Set()), render()),
  sel: (el) => (ui.selection.has(el.dataset.id) ? ui.selection.delete(el.dataset.id) : ui.selection.add(el.dataset.id), render()),
  'sel-all': () => ((ui.selection = ui.selection.size === lists.lib.length ? new Set() : new Set(lists.lib)), render()),
  'sel-pl': () => addToPlaylistSheet([...ui.selection]),
  'sel-next': () => (Player.playNext([...ui.selection]), toast('Sera lu ensuite'), (ui.selection = null), render()),
  'sel-del': () => deleteTracks([...ui.selection], () => ((ui.selection = null), render())),
  async 'new-pl'() {
    const name = await dialog({ title: 'Nouvelle playlist', input: '', ok: 'Créer' });
    if (name === null) return;
    const id = S.createPlaylist(name);
    toast('Playlist créée');
    location.hash = '#/playlist/' + id;
  },
  'import-pl': () => importPlaylistSheet(),
  'toggle-missing': () => ((ui.showMissing = !ui.showMissing), render()),
  async 'clear-missing'(el) {
    if (await dialog({ title: 'Ne plus attendre ces titres ?', text: 'Ils seront retirés de la liste d’attente de cette playlist.', ok: 'Confirmer' })) S.patchPlaylist(el.dataset.id, { missing: [] });
  },
  'pl-edit': () => ((ui.plEdit = !ui.plEdit), render()),
  'pl-move': (el) => S.movePlaylistTrack(el.dataset.id, +el.dataset.i, +el.dataset.i + +el.dataset.d),
  'pl-remove': (el) => S.removeFromPlaylist(el.dataset.id, +el.dataset.i),
  'pl-add': (el) => plAddSheet(el.dataset.id),
  async 'pl-image'(el) {
    const f = await pickFile('image-input');
    if (f) await S.setPlaylistImage(el.dataset.id, f[0]);
  },
  async 'pl-rename'(el) {
    const p = S.getPlaylist(el.dataset.id);
    const name = await dialog({ title: 'Renommer', input: p.name, ok: 'Enregistrer' });
    if (name !== null) S.renamePlaylist(p.id, name);
  },
  'pl-menu'(el) {
    const p = S.getPlaylist(el.dataset.id);
    openSheet(
      `<div class="dlg" style="padding-bottom:0"><h3>${esc(p.name)}</h3></div>
      <button class="sitem" data-m="rename">${icon('edit', 22)}Renommer</button>
      <button class="sitem" data-m="image">${icon('image', 22)}Changer l’image</button>
      ${p.imageKey ? `<button class="sitem" data-m="noimage">${icon('close', 22)}Retirer l’image</button>` : ''}
      <button class="sitem" data-m="queue">${icon('queue', 22)}Ajouter à la file d’attente</button>
      <button class="sitem danger" data-m="delete">${icon('trash', 22)}Supprimer la playlist</button>`,
      (sh, close) =>
        sh.addEventListener('click', async (e) => {
          const m = e.target.closest('[data-m]')?.dataset.m;
          if (!m) return;
          close();
          if (m === 'rename') ACTS['pl-rename'](el);
          if (m === 'image') ACTS['pl-image'](el);
          if (m === 'noimage') S.setPlaylistImage(p.id, null);
          if (m === 'queue') (Player.addToQueue(p.trackIds), toast('Ajouté à la file'));
          if (m === 'delete' && (await dialog({ title: 'Supprimer la playlist ?', text: 'Les morceaux restent dans ta bibliothèque.', ok: 'Supprimer', danger: true }))) {
            await S.deletePlaylist(p.id);
            history.back();
          }
        }),
    );
  },
  async 'save-track'(el) {
    const v = (k) => $('#f-' + k)?.value.trim();
    const t = S.getTrack(el.dataset.id);
    await S.updateTrack(t.id, { title: v('title') || t.title, artist: v('artist') || 'Artiste inconnu', album: v('album') || 'Album inconnu', genre: v('genre') || '' });
    Player.refreshMeta();
    toast('Modifications enregistrées');
    history.back();
  },
  async 'track-art'(el) {
    const f = await pickFile('image-input');
    if (!f) return;
    await S.setTrackArtwork([el.dataset.id], f[0]);
    Player.refreshMeta();
    lastRouteKey = '';
    render();
  },
  async 'track-art-remove'(el) {
    await S.setTrackArtwork([el.dataset.id], null);
    lastRouteKey = '';
    render();
  },
  async 'track-art-album'(el) {
    const t = S.getTrack(el.dataset.id);
    const blob = await (await import('./db.js')).db.getBlob(t.artKey);
    const others = S.allTracks().filter((x) => x.album === t.album && x.artist === t.artist && x.id !== t.id);
    await S.setTrackArtwork(others.map((x) => x.id), blob);
    toast(others.length ? `Pochette appliquée à ${plural(others.length, 'autre titre', 'autres titres')}` : 'Aucun autre titre dans cet album');
  },
  'delete-tracks': (el) => deleteTracks([el.dataset.id], () => history.back()),
  'clear-history': async () => (await dialog({ title: 'Effacer l’historique ?', text: 'Les statistiques sont conservées.', ok: 'Effacer', danger: true })) && S.clearHistory(),
  'reset-stats': async () => (await dialog({ title: 'Réinitialiser les statistiques ?', text: 'Compteurs, temps d’écoute et historique seront remis à zéro.', ok: 'Réinitialiser', danger: true })) && S.resetStats(),
  theme: (el) => S.setSettings({ theme: el.dataset.k }),
  accent: (el) => S.setSettings({ accent: el.dataset.k }),
  'toggle-resume': () => S.setSettings({ autoResume: !S.state.settings.autoResume }),
  async wipe() {
    if (!(await dialog({ title: 'Tout supprimer ?', text: 'Musiques, playlists, favoris et statistiques seront effacés de SONORA. Action irréversible.', ok: 'Tout supprimer', danger: true }))) return;
    Player.forget(S.allTracks().map((t) => t.id));
    await S.wipeAll();
    toast('Bibliothèque vidée');
  },
  async export() {
    const json = JSON.stringify(S.buildBackup(), null, 2);
    const name = `sonora-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: 'Sauvegarde SONORA' });
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  async restore() {
    const f = await pickFile('backup-input');
    if (!f) return;
    try {
      const r = S.restoreBackup(JSON.parse(await f[0].text()));
      dialog({ title: 'Sauvegarde restaurée', text: `${plural(r.count, 'playlist ajoutée', 'playlists ajoutées')}.${r.missing ? ` ${r.missing} morceau(x) introuvable(s) : importe d’abord les fichiers correspondants.` : ''}`, ok: 'OK', cancel: 'Fermer' });
    } catch (e) {
      dialog({ title: 'Restauration impossible', text: e.message, ok: 'OK', cancel: 'Fermer' });
    }
  },
  // Lecteur
  toggle: () => Player.toggle(),
  next: () => Player.next(),
  'close-player': closePlayer,
  'p-toggle': () => Player.toggle(),
  'p-next': () => Player.next(),
  'p-prev': () => Player.previous(),
  'p-shuffle': () => (Player.toggleShuffle(), toast(P.shuffle ? 'Lecture aléatoire' : 'Aléatoire désactivé')),
  'p-repeat': () => {
    const r = Player.cycleRepeat();
    toast(r === 'off' ? 'Répétition désactivée' : r === 'all' ? 'Répéter la file' : 'Répéter ce morceau');
  },
  fav: (el) => (S.toggleFav(el.dataset.id), renderPlayer()),
  sleep: sleepSheet,
  queue: queueSheet,
};

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    e.preventDefault();
    location.hash = go.dataset.go;
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) {
    e.stopPropagation();
    ACTS[el.dataset.act]?.(el, e);
    return;
  }
  if (e.target.closest('#mini')) openPlayer();
});

view.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    ui.q = e.target.value;
    renderSearchResults();
  }
});

/* =============================== THÈME ================================== */
function applyTheme() {
  const { theme, accent } = S.state.settings;
  const dark = theme === 'system' ? !matchMedia('(prefers-color-scheme: light)').matches : theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = accent;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#08080C' : '#F6F6F9';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

async function updateStorage() {
  const box = $('#storage');
  if (!box) return;
  const used = S.allTracks().reduce((a, t) => a + (t.size || 0), 0);
  const e = await storageEstimate();
  box.innerHTML = `<div class="row-between"><b style="font-weight:600">Espace utilisé par SONORA</b><b style="color:var(--a)">${fmtBytes(e.usage || used)}</b></div>
    ${e.quota ? `<div class="meter" style="margin:8px 0"><div style="width:${Math.min(100, (e.usage / e.quota) * 100)}%"></div></div><p class="muted" style="font-size:12px">Musique ${fmtBytes(used)} · Disponible pour SONORA ${fmtBytes(Math.max(0, e.quota - e.usage))}</p>` : ''}`;
}

/* =============================== DÉMARRAGE ============================== */
async function boot() {
  const tabs = [['home', 'Accueil'], ['search', 'Recherche'], ['library', 'Bibliothèque'], ['playlists', 'Playlists'], ['settings', 'Réglages']];
  document.querySelectorAll('#tabs a').forEach((a, i) => (a.innerHTML = icon(tabs[i][0], 24) + `<span>${tabs[i][1]}</span>`));
  try {
    await S.loadLibrary();
  } catch (e) {
    console.error(e);
    toast('Stockage local indisponible (navigation privée ?)');
  }
  applyTheme();
  initPlayer();
  S.subscribe(() => {
    applyTheme();
    render();
    if (route().name === 'settings') updateStorage();
  });
  addEventListener('hashchange', () => {
    ui.plEdit = false;
    if (route().name !== 'library') ui.selection = null;
    closeSheet(true);
    if (ui.playerOpen) closePlayer();
    render();
    if (route().name === 'settings') updateStorage();
  });
  render();
  if (route().name === 'settings') updateStorage();
  S.fixDurations();
  if (S.state.tracks.size) requestPersistence();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
boot();
