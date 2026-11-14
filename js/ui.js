// Utilitaires d'interface : formatage, pochettes, feuilles modales, dialogues, toasts.
import { icon } from './icons.js';
import { blobUrl, cachedUrl } from './store.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
}
export function fmtLong(sec) {
  if (sec > 0 && sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
export function fmtBytes(b) {
  if (!b) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
export const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const plural = (n, w, p = w + 's') => `${n} ${n > 1 ? p : w}`;

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
export const SORT_LABELS = { added: 'Date d’ajout', title: 'Titre', artist: 'Artiste', album: 'Album', duration: 'Durée' };
export function sortTracks(list, key, desc) {
  const a = [...list];
  a.sort((x, y) => {
    if (key === 'title') return collator.compare(x.title, y.title);
    if (key === 'artist') return collator.compare(x.artist, y.artist) || collator.compare(x.title, y.title);
    if (key === 'album') return collator.compare(x.album, y.album) || collator.compare(x.title, y.title);
    if (key === 'duration') return !x.duration ? 1 : !y.duration ? -1 : x.duration - y.duration;
    return y.addedAt - x.addedAt;
  });
  return desc ? a.reverse() : a;
}
export const compareFr = (a, b) => collator.compare(a, b);

export function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function hashColors(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 40 + (Math.abs(h >> 8) % 60)) % 360;
  return [`hsl(${hue} 70% 45%)`, `hsl(${hue2} 75% 30%)`];
}

/** Pochette : image stockée si présente, sinon dégradé généré. Chargée après rendu (hydrateArt). */
export function art(key, seed, size, { radius = 12, ic = 'note', cls = '' } = {}) {
  const [a, b] = hashColors(seed || '');
  const url = goodArt.has(key) ? cachedUrl(key) : null;
  const st = `width:${size}px;height:${size}px;border-radius:${radius}px;background-image:${url ? `url('${url}')` : `linear-gradient(135deg,${a},${b})`}`;
  return `<div class="art ${cls}" style="${st}" ${key && !url && !badArt.has(key) ? `data-art="${esc(key)}"` : ''}>${url ? '' : `<span class="art-ic">${icon(ic, Math.round(size * 0.38))}</span>`}</div>`;
}
/** Pochettes illisibles (image corrompue) : on garde le dégradé au lieu d'un carré vide. */
const badArt = new Set();
const goodArt = new Set();
const checked = new Map();
const decodes = (u) =>
  checked.get(u) ??
  checked
    .set(
      u,
      new Promise((ok) => {
        const i = new Image();
        i.onload = () => ok(i.naturalWidth > 0);
        i.onerror = () => ok(false);
        i.src = u;
      }),
    )
    .get(u);
export function hydrateArt(root = document) {
  root.querySelectorAll('[data-art]').forEach(async (el) => {
    const key = el.getAttribute('data-art');
    el.removeAttribute('data-art');
    const u = await blobUrl(key);
    if (!u) return;
    if (!(await decodes(u))) {
      badArt.add(key);
      return;
    }
    goodArt.add(key);
    el.style.backgroundImage = `url("${u}")`;
    el.innerHTML = '';
  });
}

/* --------------------------------- toast -------------------------------- */
let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

/* ------------------------------ feuille modale --------------------------- */
let sheetClose = null;
export function openSheet(html, onMount) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog"><div class="grabber"></div><div class="sheet-body">${html}</div></div>`;
  const el = root.querySelector('.sheet');
  requestAnimationFrame(() => root.classList.add('open'));
  root.querySelector('.sheet-backdrop').onclick = () => closeSheet();
  sheetClose = null;
  onMount?.(el, closeSheet);
  hydrateArt(el);
  return el;
}
export function closeSheet(instant) {
  const root = document.getElementById('sheet-root');
  if (!root.innerHTML) return;
  const f = sheetClose;
  sheetClose = null;
  f?.();
  root.classList.remove('open');
  if (instant) root.innerHTML = '';
  else setTimeout(() => !root.classList.contains('open') && (root.innerHTML = ''), 260);
}
export const onSheetClose = (fn) => (sheetClose = fn);

/** Boîte de dialogue (confirmation ou saisie) → Promise. */
export function dialog({ title, text = '', input = null, ok = 'OK', danger = false, cancel = 'Annuler' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      closeSheet();
    };
    openSheet(
      `<div class="dlg">
        <h3>${esc(title)}</h3>
        ${text ? `<p class="muted">${esc(text)}</p>` : ''}
        ${input !== null ? `<input class="field" id="dlg-input" value="${esc(input)}" autocomplete="off" />` : ''}
        <div class="dlg-btns">
          <button class="btn ghost" data-v="0">${esc(cancel)}</button>
          <button class="btn ${danger ? 'danger' : 'grad'}" data-v="1">${esc(ok)}</button>
        </div>
      </div>`,
      (el) => {
        const inp = el.querySelector('#dlg-input');
        if (inp) setTimeout(() => (inp.focus(), inp.select()), 50);
        inp?.addEventListener('keydown', (e) => e.key === 'Enter' && finish(inp.value));
        el.querySelectorAll('[data-v]').forEach((b) =>
          b.addEventListener('click', () => finish(b.dataset.v === '1' ? (inp ? inp.value : true) : null)),
        );
        onSheetClose(() => {
          if (!done) {
            done = true;
            resolve(null);
          }
        });
      },
    );
  });
}

export function emptyState(ic, title, text = '', action = '') {
  return `<div class="empty"><div class="empty-ic">${icon(ic, 34)}</div><h3>${esc(title)}</h3>${text ? `<p class="muted">${esc(text)}</p>` : ''}${action}</div>`;
}

export function pickFile(id) {
  return new Promise((resolve) => {
    const inp = document.getElementById(id);
    inp.value = '';
    inp.onchange = () => resolve(inp.files && inp.files.length ? inp.files : null);
    inp.click();
  });
}
