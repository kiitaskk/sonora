// Moteur de lecture : élément <audio>, file d'attente, Media Session (écran verrouillé, AirPods, CarPlay…).
import { db } from './db.js';
import { addListen, blobUrl, emit, getTrack, logPlay, setSession, state } from './store.js';

const audio = document.getElementById('audio');
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
    return audio.volume;
  },
};

// Abonnés légers à la progression (évite de redessiner toute la page 4×/s)
const progressSubs = new Set();
export const onProgress = (fn) => (progressSubs.add(fn), () => progressSubs.delete(fn));

let currentUrl = null;
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

async function loadIndex(i, { autoplay = true, position = 0, log = true } = {}) {
  const id = P.queue[i];
  const t = getTrack(id);
  if (!t) return;
  P.index = i;
  const token = ++loadToken;
  const blob = await db.getBlob(t.audioKey);
  if (token !== loadToken) return;
  if (!blob) {
    console.warn('fichier manquant', t.fileName);
    return;
  }
  const url = URL.createObjectURL(blob);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  audio.src = url;
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
  audio.addEventListener('play', () => ((P.playing = true), (lastTick = performance.now()), updatePositionState(), emit()));
  audio.addEventListener('pause', () => {
    P.playing = false;
    flushListen();
    persist();
    emit();
  });
  audio.addEventListener('timeupdate', () => {
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
  });
  audio.addEventListener('loadedmetadata', updatePositionState);
  audio.addEventListener('ended', onEnded);
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
  pause: () => audio.pause(),
  toggle() {
    if (!P.queue.length) return;
    P.playing ? Player.pause() : Player.play();
  },
  next() {
    if (!P.queue.length) return;
    if (P.index < P.queue.length - 1) loadIndex(P.index + 1);
    else if (P.repeat === 'all') loadIndex(0);
    else {
      audio.pause();
      audio.currentTime = 0;
    }
  },
  previous() {
    if (!P.queue.length) return;
    if (audio.currentTime > 3 || P.index === 0) audio.currentTime = 0;
    else loadIndex(P.index - 1);
  },
  seek(sec) {
    try {
      audio.currentTime = Math.max(0, Math.min(sec, P.duration || sec));
    } catch {}
    updatePositionState();
    progressSubs.forEach((f) => f());
  },
  jumpTo: (i) => loadIndex(i),
  setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, v));
  },
  cycleRepeat() {
    P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
    persist();
    emit();
    return P.repeat;
  },
  toggleShuffle() {
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
    if (i === P.index) return;
    P.queue.splice(i, 1);
    if (i < P.index) P.index--;
    persist();
    emit();
  },
  moveInQueue(from, to) {
    if (to <= P.index || to >= P.queue.length) return;
    P.queue.splice(to, 0, P.queue.splice(from, 1)[0]);
    persist();
    emit();
  },
  clearQueue() {
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
        audio.pause();
        cancelSleep();
        emit();
      }, min * 60000);
    }
    emit();
  },
};
