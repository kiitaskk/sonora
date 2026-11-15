// Moteur de lecture : élément <audio>, file d'attente, Media Session (écran verrouillé, AirPods, CarPlay…).
import { db } from './db.js';
import { addListen, blobUrl, emit, getTrack, logPlay, setSession, state } from './store.js';

// Deux lecteurs audio : pendant un fondu enchaîné, le suivant démarre pendant que l'actuel s'éteint.
const elA = document.getElementById('audio');
const elB = document.createElement('audio');
elB.preload = 'auto';
elB.setAttribute('playsinline', '');
document.body.appendChild(elB);
let audio = elA; // lecteur actif (celui du morceau affiché)
const other = () => (audio === elA ? elB : elA);

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Le fondu demande de pouvoir régler le volume, ce que Safari iOS interdit aux apps web. */
export const canFade = (() => {
  if (isIOS) return false;
  try {
    const a = new Audio();
    a.volume = 0.5;
    return Math.abs(a.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
})();
let userVolume = 1;

export const P = {
  queue: [],
  original: null,
  index: 0,
  playing: false,
  repeat: 'off', // off | all | one
  shuffle: false,
  sleepAt: null,
  sleepEnd: false,
  get current() {
    return getTrack(this.queue[this.index]);
  },
  get position() {
    return audio.currentTime || 0;
  },
  get duration() {
    return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : this.current?.duration || 0;
  },
  get volume() {
    return userVolume;
  },
  get fading() {
    return !!fade;
  },
};

// Abonnés légers à la progression (évite de redessiner toute la page 4×/s)
const progressSubs = new Set();
export const onProgress = (fn) => (progressSubs.add(fn), () => progressSubs.delete(fn));

const urls = new Map(); // élément audio → URL du fichier chargé
let fade = null; // fondu en cours : { from, timer }
let loadToken = 0;
let lastTick = 0;
let listenAcc = { id: null, sec: 0 };
let sleepTimer = null;

const shuffleArr = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function setSrc(el, blob) {
  const old = urls.get(el);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  urls.set(el, url);
  el.src = url;
}

function stopEl(el) {
  el.pause();
  const u = urls.get(el);
  el.removeAttribute('src');
  try {
    el.load();
  } catch {}
  if (u) URL.revokeObjectURL(u);
  urls.delete(el);
}

/** Termine immédiatement un fondu en cours (l'ancien morceau s'arrête). */
function endFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  stopEl(fade.from);
  fade = null;
  audio.volume = userVolume;
}

async function loadIndex(i, { autoplay = true, position = 0, log = true } = {}) {
  const id = P.queue[i];
  const t = getTrack(id);
  if (!t) return;
  endFade();
  P.index = i;
  const token = ++loadToken;
  const blob = await db.getBlob(t.audioKey);
  if (token !== loadToken) return;
  if (!blob) {
    console.warn('fichier manquant', t.fileName);
    return;
  }
  setSrc(audio, blob);
  audio.volume = userVolume;
  if (position > 0) {
    const seek = () => {
      try {
        audio.currentTime = position;
      } catch {}
      audio.removeEventListener('loadedmetadata', seek);
    };
    audio.addEventListener('loadedmetadata', seek);
  }
  if (autoplay) {
    try {
      await audio.play();
    } catch (e) {
      console.warn('play bloqué', e);
    }
  }
  if (log && autoplay) logPlay(id);
  updateMediaSession();
  persist();
  emit();
}

/** Index du morceau qui suivra naturellement (null s'il n'y en a pas). */
function nextIndex() {
  if (P.repeat === 'one' || P.sleepEnd) return null;
  if (P.index < P.queue.length - 1) return P.index + 1;
  if (P.repeat === 'all' && P.queue.length > 1) return 0;
  return null;
}

let fadeStarting = false;
async function maybeStartFade() {
  const secs = canFade ? Number(state.settings.crossfade) || 0 : 0;
  if (!secs || fade || fadeStarting || !P.playing) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  const len = Math.min(secs, d * 0.4);
  if (d - audio.currentTime > len) return;
  const ni = nextIndex();
  if (ni === null) return;
  const t = getTrack(P.queue[ni]);
  if (!t) return;
  fadeStarting = true;
  try {
    const blob = await db.getBlob(t.audioKey);
    if (!blob || fade || !P.playing) return;
    const from = audio;
    const prevIndex = P.index;
    const to = other();
    setSrc(to, blob);
    to.volume = 0;
    // Le nouveau morceau devient le morceau affiché dès le début du fondu
    audio = to;
    P.index = ni;
    flushListen();
    try {
      await to.play();
    } catch (e) {
      // Lecture refusée : on revient au lecteur précédent sans fondu
      audio = from;
      P.index = prevIndex;
      stopEl(to);
      return;
    }
    logPlay(P.queue[ni]);
    updateMediaSession();
    persist();
    emit();
    const start = performance.now();
    const remaining = Math.max(0.3, Math.min(len, (from.duration || len) - from.currentTime));
    fade = {
      from,
      timer: setInterval(() => {
        const k = Math.min(1, (performance.now() - start) / (remaining * 1000));
        // Courbe « puissance constante » : pas de creux de volume au milieu
        to.volume = userVolume * Math.sin((k * Math.PI) / 2);
        from.volume = userVolume * Math.cos((k * Math.PI) / 2);
        if (k >= 1 || from.ended || from.paused) endFade();
      }, 50),
    };
  } finally {
    fadeStarting = false;
  }
}

function persist() {
  setSession(P.queue.length ? { queue: P.queue, index: P.index, position: P.position, repeat: P.repeat, shuffle: P.shuffle } : null);
}

async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = P.current;
  if (!t) return;
  const art = t.artKey ? await blobUrl(t.artKey) : null;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const h = (a, f) => {
    try {
      ms.setActionHandler(a, f);
    } catch {}
  };
  h('play', () => Player.play());
  h('pause', () => Player.pause());
  h('previoustrack', () => Player.previous());
  h('nexttrack', () => Player.next());
  h('seekto', (d) => d.seekTime != null && Player.seek(d.seekTime));
  h('stop', () => Player.pause());
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = P.duration;
  if (!d) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(P.position, d), playbackRate: 1 });
  } catch {}
}

function flushListen() {
  if (listenAcc.id && listenAcc.sec >= 1) addListen(listenAcc.id, Math.round(listenAcc.sec));
  listenAcc = { id: null, sec: 0 };
}

export function initPlayer() {
  setupMediaSession();
  for (const el of [elA, elB]) {
    el.addEventListener('play', () => {
      if (el !== audio) return;
      P.playing = true;
      lastTick = performance.now();
      updatePositionState();
      emit();
    });
    el.addEventListener('pause', () => {
      if (el !== audio) return;
      P.playing = false;
      flushListen();
      persist();
      emit();
    });
    el.addEventListener('timeupdate', () => {
      if (el !== audio) return;
      const now = performance.now();
      const id = P.queue[P.index];
      if (P.playing && lastTick && id) {
        if (listenAcc.id !== id) flushListen();
        listenAcc.id = id;
        listenAcc.sec += Math.min(2, (now - lastTick) / 1000);
        if (listenAcc.sec > 20) flushListen();
      }
      lastTick = now;
      progressSubs.forEach((f) => f());
      maybeStartFade();
    });
    el.addEventListener('loadedmetadata', () => el === audio && updatePositionState());
    el.addEventListener('ended', () => el === audio && onEnded());
  }
  setInterval(() => P.playing && persist(), 5000);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => document.hidden && persist());

  // Reprise de la dernière écoute (en pause)
  const s = state.session;
  if (state.settings.autoResume && s?.queue?.length) {
    const queue = s.queue.filter((id) => getTrack(id));
    if (queue.length) {
      P.queue = queue;
      P.repeat = s.repeat || 'off';
      P.shuffle = !!s.shuffle;
      const idx = Math.max(0, queue.indexOf(s.queue[s.index]));
      loadIndex(idx, { autoplay: false, position: s.position || 0, log: false });
    }
  }
}

function onEnded() {
  if (P.sleepEnd) {
    cancelSleep();
    emit();
    return;
  }
  if (P.repeat === 'one') {
    audio.currentTime = 0;
    audio.play();
    logPlay(P.queue[P.index]);
    return;
  }
  if (P.index < P.queue.length - 1) loadIndex(P.index + 1);
  else if (P.repeat === 'all' && P.queue.length) loadIndex(0);
  else {
    P.playing = false;
    audio.currentTime = 0;
    emit();
  }
}

function cancelSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  P.sleepAt = null;
  P.sleepEnd = false;
}

export const Player = {
  playList(ids, start = 0, { shuffle } = {}) {
    const valid = ids.filter((id) => getTrack(id));
    if (!valid.length) return;
    const startId = getTrack(ids[start]) ? ids[start] : valid[0];
    const sh = shuffle ?? P.shuffle;
    if (sh) {
      const first = shuffle && start === 0 ? valid[Math.floor(Math.random() * valid.length)] : startId;
      P.original = valid;
      P.queue = [first, ...shuffleArr(valid.filter((x) => x !== first))];
      P.shuffle = true;
      return loadIndex(0);
    }
    P.shuffle = false;
    P.original = null;
    P.queue = valid;
    return loadIndex(Math.max(0, valid.indexOf(startId)));
  },
  play() {
    if (!audio.src && P.queue.length) return loadIndex(P.index);
    return audio.play().catch(() => {});
  },
  pause() {
    endFade();
    audio.pause();
  },
  toggle() {
    if (!P.queue.length) return;
    P.playing ? Player.pause() : Player.play();
  },
  next() {
    if (!P.queue.length) return;
    if (P.index < P.queue.length - 1) loadIndex(P.index + 1);
    else if (P.repeat === 'all') loadIndex(0);
    else {
      endFade();
      audio.pause();
      audio.currentTime = 0;
    }
  },
  previous() {
    if (!P.queue.length) return;
    endFade();
    if (audio.currentTime > 3 || P.index === 0) audio.currentTime = 0;
    else loadIndex(P.index - 1);
  },
  seek(sec) {
    endFade();
    try {
      audio.currentTime = Math.max(0, Math.min(sec, P.duration || sec));
    } catch {}
    updatePositionState();
    progressSubs.forEach((f) => f());
  },
  jumpTo: (i) => loadIndex(i),
  setVolume(v) {
    userVolume = Math.max(0, Math.min(1, v));
    if (!fade) audio.volume = userVolume;
  },
  cycleRepeat() {
    P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
    persist();
    emit();
    return P.repeat;
  },
  toggleShuffle() {
    endFade();
    if (!P.queue.length) {
      P.shuffle = !P.shuffle;
      emit();
      return;
    }
    const cur = P.queue[P.index];
    if (!P.shuffle) {
      P.original = P.queue;
      P.queue = [cur, ...shuffleArr(P.queue.filter((_, i) => i !== P.index))];
      P.index = 0;
      P.shuffle = true;
    } else {
      const base = (P.original || P.queue).filter((id) => P.queue.includes(id));
      P.queue.forEach((id) => !base.includes(id) && base.push(id));
      P.queue = base;
      P.index = Math.max(0, base.indexOf(cur));
      P.shuffle = false;
      P.original = null;
    }
    persist();
    emit();
  },
  playNext(ids) {
    if (!P.queue.length) return Player.playList(ids, 0);
    P.queue.splice(P.index + 1, 0, ...ids.filter((id) => getTrack(id)));
    persist();
    emit();
  },
  addToQueue(ids) {
    if (!P.queue.length) return Player.playList(ids, 0);
    P.queue.push(...ids.filter((id) => getTrack(id)));
    persist();
    emit();
  },
  removeFromQueue(i) {
    endFade();
    if (i === P.index) return;
    P.queue.splice(i, 1);
    if (i < P.index) P.index--;
    persist();
    emit();
  },
  moveInQueue(from, to) {
    endFade();
    if (to <= P.index || to >= P.queue.length) return;
    P.queue.splice(to, 0, P.queue.splice(from, 1)[0]);
    persist();
    emit();
  },
  clearQueue() {
    endFade();
    const cur = P.queue[P.index];
    if (!cur) return;
    P.queue = [cur];
    P.index = 0;
    P.original = null;
    persist();
    emit();
  },
  forget(ids) {
    const del = new Set(ids);
    if (!P.queue.some((q) => del.has(q))) return;
    const cur = P.queue[P.index];
    P.queue = P.queue.filter((q) => !del.has(q));
    if (del.has(cur)) {
      endFade();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      P.index = Math.min(P.index, Math.max(0, P.queue.length - 1));
      if (P.queue.length) loadIndex(P.index, { autoplay: false, log: false });
    } else P.index = P.queue.indexOf(cur);
    persist();
    emit();
  },
  refreshMeta: updateMediaSession,
  setSleep(min) {
    cancelSleep();
    if (min === 'end') P.sleepEnd = true;
    else if (min) {
      P.sleepAt = Date.now() + min * 60000;
      sleepTimer = setTimeout(() => {
        endFade();
        audio.pause();
        cancelSleep();
        emit();
      }, min * 60000);
    }
    emit();
  },
};
