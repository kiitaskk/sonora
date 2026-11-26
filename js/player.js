// Moteur de lecture : élément <audio>, file d'attente, Media Session (écran verrouillé, AirPods, CarPlay…).
import { db } from './db.js';
import { addListen, blobUrl, emit, getTrack, logPlay, setSession, state } from './store.js';

/* Journal de lecture (dépannage) : derniers événements, gardés dans le téléphone */
const LOG_KEY = 'sonora-log';
export function jlog(msg) {
  try {
    const t = new Date();
    const line = `${t.toLocaleTimeString('fr-FR')} ${document.hidden ? '🌙' : '☀️'} ${msg}`;
    const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    arr.push(line);
    localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-80)));
  } catch {}
}
export const getLog = () => {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
};
export const clearLog = () => {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {}
};

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Deux lecteurs audio : pendant un fondu enchaîné, le suivant démarre pendant que l'actuel s'éteint.
const elA = document.getElementById('audio');
const elB = document.createElement('audio');
elB.preload = 'auto';
elB.setAttribute('playsinline', '');
document.body.appendChild(elB);
let audio = elA; // lecteur actif (celui du morceau affiché)

/**
 * Flux de maintien : un son inaudible (≈ -90 dB) joué en boucle tant que SONORA est « en lecture ».
 * En veille, Android ralentit fortement les apps : sans lui, entre deux morceaux le son s'arrête,
 * Android retire la notification de lecture et fige l'app avant que le morceau suivant ne démarre.
 * Avec lui, l'app « joue » en continu : le morceau suivant démarre même si le code se réveille en retard.
 */
function quietWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  // Signal minuscule mais non nul (sinon Android peut le considérer comme « pas de son »)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return new Blob([buf], { type: 'audio/wav' });
}
const keep = document.createElement('audio');
keep.loop = true;
keep.preload = 'auto';
keep.setAttribute('playsinline', '');
keep.dataset.keepalive = '1';
document.body.appendChild(keep);
let keepReady = false;
function keepAlive(on) {
  if (isIOS) return;
  if (on) {
    if (!keepReady) {
      keep.src = URL.createObjectURL(quietWav(12));
      keepReady = true;
    }
    if (keep.paused) keep.play().catch((e) => jlog('maintien refusé : ' + e.name));
  } else if (!keep.paused) keep.pause();
}
const other = () => (audio === elA ? elB : elA);

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
let pre = null; // morceau suivant déjà chargé dans le 2e lecteur : { id, el }
let preparing = false;
let resumeWanted = false; // lecture refusée en arrière-plan : on relance au retour dans l'app
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
  if (pre?.el === el) pre = null;
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
  prepareNext();
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
      jlog('lecture → ' + t.title);
      await audio.play();
      resumeWanted = false;
    } catch (e) {
      console.warn('play bloqué', e);
      jlog('lecture refusée : ' + e.name);
      if (e?.name === 'NotAllowedError') {
        resumeWanted = true;
        P.playing = false;
        emit();
      }
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

/**
 * Prépare le morceau suivant dans le 2e lecteur, bien avant la fin du morceau en cours.
 * Au moment de l'enchaînement il n'y a donc plus rien à charger : il démarre instantanément.
 */
async function prepareNext() {
  if (isIOS || preparing || fade) return;
  const ni = nextIndex();
  if (ni === null) return;
  const id = P.queue[ni];
  if (pre && pre.id === id && pre.el === other()) return;
  const t = getTrack(id);
  if (!t) return;
  preparing = true;
  try {
    const blob = await db.getBlob(t.audioKey);
    if (!blob || fade || P.queue[nextIndex()] !== id) return;
    const el = other();
    setSrc(el, blob);
    el.volume = 0;
    el.preload = 'auto';
    try {
      el.load();
    } catch {}
    pre = { id, el };
  } finally {
    preparing = false;
  }
}

/**
 * Démarre le morceau préparé. Le son ne s'interrompt jamais entre deux titres :
 * c'est ce qui empêche Android de couper la lecture écran verrouillé.
 * fadeLen = durée du fondu (quelques dixièmes de seconde si le fondu enchaîné est réglé sur 0).
 */
function startNext(fadeLen) {
  const ni = nextIndex();
  if (ni === null) return false;
  const id = P.queue[ni];
  if (!pre || pre.id !== id || pre.el !== other()) return false;
  const from = audio;
  const to = pre.el;
  const prevIndex = P.index;
  pre = null;
  audio = to;
  P.index = ni;
  flushListen();
  // Fondu seulement app à l'écran : en veille, Android gèle les minuteries qui remontent le volume
  const smooth = fadeLen > 0 && !document.hidden && !from.ended && !from.paused;
  to.volume = smooth ? 0 : userVolume;
  jlog(`suivant (${smooth ? 'fondu' : from.ended ? 'fin du morceau' : 'enchaîné'}) → ${getTrack(id)?.title}`);
  to.play()
    .then(() => (resumeWanted = false))
    .catch((e) => {
      console.warn('enchaînement bloqué', e);
      jlog('lecture du suivant refusée : ' + e.name);
      if (audio !== to) return;
      if (!from.ended && !from.paused) {
        // Le morceau précédent joue encore : on y revient, sans coupure
        if (fade) clearInterval(fade.timer);
        fade = null;
        stopEl(to);
        audio = from;
        P.index = prevIndex;
        from.volume = userVolume;
      } else {
        P.playing = false;
        resumeWanted = true;
      }
      emit();
    });
  logPlay(id);
  updateMediaSession();
  persist();
  emit();
  if (!smooth) {
    stopEl(from);
    return true;
  }
  const t0 = performance.now();
  const len = Math.max(0.05, Math.min(fadeLen, (from.duration || fadeLen) - from.currentTime));
  fade = {
    from,
    endAt: t0 + len * 1000,
    timer: setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (len * 1000));
      // Courbe « puissance constante » : pas de creux de volume au milieu
      to.volume = userVolume * Math.sin((k * Math.PI) / 2);
      from.volume = userVolume * Math.cos((k * Math.PI) / 2);
      if (k >= 1 || from.ended || from.paused) endFade();
    }, 40),
  };
  return true;
}

/** Appelé pendant la lecture : prépare puis lance le suivant au bon moment. */
function onTick() {
  if (isIOS || !P.playing) return;
  if (fade) {
    // Sécurité : si la minuterie du fondu a été gelée, on termine le fondu tout de suite
    if (document.hidden || performance.now() > fade.endAt + 1500) endFade();
    return;
  }
  // Sécurité : le morceau en cours ne doit jamais rester à un volume réduit
  if (Math.abs(audio.volume - userVolume) > 0.01) audio.volume = userVolume;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  const rem = d - audio.currentTime;
  if (rem <= 30) prepareNext();
  const secs = canFade && !document.hidden ? Number(state.settings.crossfade) || 0 : 0;
  if (secs > 0) {
    const win = Math.min(secs, d * 0.4);
    if (rem <= win) startNext(win);
  } else if (rem <= 0.3) startNext(0); // bascule nette, volume plein, sans minuterie
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

function setMsState(st) {
  try {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st;
  } catch {}
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
      setMsState('playing');
      keepAlive(true);
      P.playing = true;
      prepareNext(); // le suivant est prêt bien à l'avance, même si l'app est ensuite endormie
      lastTick = performance.now();
      updatePositionState();
      emit();
    });
    el.addEventListener('pause', () => {
      if (el !== audio) return;
      // Fin naturelle d'un morceau avec un suivant : ce n'est pas une pause, on garde tout actif
      if (el.ended && nextIndex() !== null) return;
      jlog(el.ended ? 'fin de la file' : 'pause');
      setMsState('paused');
      if (!el.ended) keepAlive(false);
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
      onTick();
    });
    el.addEventListener('loadedmetadata', () => el === audio && updatePositionState());
    el.addEventListener('ended', () => el === audio && (jlog('fin du morceau'), onEnded()));
    el.addEventListener('error', () => el === audio && jlog('erreur du lecteur : ' + (el.error?.message || el.error?.code || '?')));
  }
  setInterval(() => P.playing && persist(), 5000);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    jlog(document.hidden ? 'écran éteint / app en arrière-plan' : 'retour dans l’app');
    if (document.hidden) {
      endFade(); // en veille les minuteries sont gelées : pas de fondu à moitié fini
      return persist();
    }
    // De retour dans l'app : si Android avait bloqué l'enchaînement, on relance
    if (resumeWanted && audio.src) audio.play().then(() => (resumeWanted = false)).catch(() => {});
  });

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
    P.playing = false;
    keepAlive(false);
    setMsState('paused');
    emit();
    return;
  }
  if (P.repeat === 'one') {
    audio.currentTime = 0;
    audio.play();
    logPlay(P.queue[P.index]);
    return;
  }
  if (!isIOS && startNext(0)) return;
  if (P.index < P.queue.length - 1) loadIndex(P.index + 1);
  else if (P.repeat === 'all' && P.queue.length) loadIndex(0);
  else {
    P.playing = false;
    keepAlive(false);
    setMsState('paused');
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
    keepAlive(true); // dans le geste de l'utilisateur : toujours autorisé
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
    resumeWanted = false;
    keepAlive(true);
    if (!audio.src && P.queue.length) return loadIndex(P.index);
    return audio.play().catch(() => {});
  },
  pause() {
    endFade();
    keepAlive(false);
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
  jumpTo: (i) => (keepAlive(true), loadIndex(i)),
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
        keepAlive(false);
        audio.pause();
        cancelSleep();
        emit();
      }, min * 60000);
    }
    emit();
  },
};
