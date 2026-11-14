// Lecture des tags intégrés (ID3v2.2/2.3/2.4 et FLAC) directement dans le navigateur.
const MAX = 12 * 1024 * 1024;
const bytes = async (blob, s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());

export async function readTags(file) {
  try {
    const head = await bytes(file, 0, 10);
    if (head.length < 4) return {};
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = syncsafe(head, 6);
      if (size <= 0 || size > MAX) return {};
      return parseId3(head[3], head[5], await bytes(file, 10, 10 + size));
    }
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return await parseFlac(file);
    if (latin1(head, 4, 8) === 'ftyp') return await parseMp4(file);
    return {};
  } catch (e) {
    console.warn('tags', e);
    return {};
  }
}

const latin1 = (b, s = 0, e = b.length) => {
  let r = '';
  for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
  return r;
};
const utf8 = (b, s = 0, e = b.length) => new TextDecoder('utf-8').decode(b.subarray(s, e));
function utf16(b, s, e, be) {
  if (e - s >= 2) {
    if (b[s] === 0xff && b[s + 1] === 0xfe) (be = false), (s += 2);
    else if (b[s] === 0xfe && b[s + 1] === 0xff) (be = true), (s += 2);
  }
  if ((e - s) % 2) e--;
  return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(b.subarray(s, e));
}
const decode = (enc, b, s, e) => (enc === 1 ? utf16(b, s, e, false) : enc === 2 ? utf16(b, s, e, true) : enc === 3 ? utf8(b, s, e) : latin1(b, s, e));
function termEnd(enc, b, s, e) {
  if (enc === 1 || enc === 2) {
    for (let i = s; i + 1 < e; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return e;
  }
  for (let i = s; i < e; i++) if (b[i] === 0) return i;
  return e;
}
const clean = (s) => s.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function deUnsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return Uint8Array.from(out);
}
const genre = (g) => {
  const t = g.replace(/^\(\d+\)/, '').trim();
  return t && !/^\d+$/.test(t) ? t : '';
};

function parseId3(major, flags, raw) {
  const out = {};
  const b = flags & 0x80 && major < 4 ? deUnsync(raw) : raw;
  let p = 0;
  if (flags & 0x40 && major >= 3) p += major === 4 ? syncsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
  const idLen = major === 2 ? 3 : 4;
  const hdr = major === 2 ? 6 : 10;
  while (p + hdr <= b.length) {
    const id = latin1(b, p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size =
      major === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : major === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    const s = p + hdr;
    const e = s + size;
    if (size <= 0 || e > b.length) break;
    const enc = b[s];
    const text = () => clean(decode(enc, b, s + 1, e));
    if (id === 'TIT2' || id === 'TT2') out.title = text();
    else if (id === 'TPE1' || id === 'TP1') out.artist = text();
    else if ((id === 'TPE2' || id === 'TP2') && !out.artist) out.artist = text();
    else if (id === 'TALB' || id === 'TAL') out.album = text();
    else if (id === 'TCON' || id === 'TCO') out.genre = genre(text());
    else if ((id === 'APIC' || id === 'PIC') && !out.picture) {
      let mime, dStart;
      if (id === 'APIC') {
        const mEnd = termEnd(0, b, s + 1, e);
        mime = latin1(b, s + 1, mEnd) || 'image/jpeg';
        if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase();
        dStart = mEnd + 2;
      } else {
        mime = latin1(b, s + 1, s + 4).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
        dStart = s + 5;
      }
      const dEnd = termEnd(enc, b, dStart, e);
      const data = b.slice(dEnd + (enc === 1 || enc === 2 ? 2 : 1), e);
      if (data.length > 64) out.picture = new Blob([data], { type: mime });
    }
    p = e;
  }
  return out;
}

async function parseFlac(file) {
  const out = {};
  let off = 4;
  for (let g = 0; g < 64; g++) {
    const h = await bytes(file, off, off + 4);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    off += 4;
    if (type === 0 || type === 4 || (type === 6 && !out.picture && len < MAX)) {
      const d = await bytes(file, off, off + len);
      const dv = new DataView(d.buffer);
      if (type === 0 && d.length >= 18) {
        const rate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
        const total = (d[13] & 0x0f) * 2 ** 32 + ((d[14] << 24) >>> 0) + (d[15] << 16) + (d[16] << 8) + d[17];
        if (rate && total) out.duration = total / rate;
      } else if (type === 4) {
        let q = 4 + dv.getUint32(0, true);
        const n = dv.getUint32(q, true);
        q += 4;
        for (let i = 0; i < n && q + 4 <= d.length; i++) {
          const l = dv.getUint32(q, true);
          q += 4;
          const kv = utf8(d, q, q + l);
          q += l;
          const k = kv.slice(0, kv.indexOf('=')).toUpperCase();
          const v = clean(kv.slice(kv.indexOf('=') + 1));
          if (k === 'TITLE') out.title = v;
          else if (k === 'ARTIST') out.artist = out.artist || v;
          else if (k === 'ALBUMARTIST' && !out.artist) out.artist = v;
          else if (k === 'ALBUM') out.album = v;
          else if (k === 'GENRE') out.genre = v;
        }
      } else if (type === 6) {
        let q = 4;
        const ml = dv.getUint32(q);
        q += 4;
        const mime = latin1(d, q, q + ml) || 'image/jpeg';
        q += ml;
        q += 4 + dv.getUint32(q) + 16;
        const pl = dv.getUint32(q);
        q += 4;
        out.picture = new Blob([d.slice(q, q + pl)], { type: mime });
      }
    }
    off += len;
    if (last) break;
  }
  return out;
}

/* --------------------- M4A / AAC (iTunes, Apple Music hors DRM) --------------------- */
async function parseMp4(file) {
  // Trouve l'atome "moov" au premier niveau (il peut être en fin de fichier)
  let off = 0;
  let moov = null;
  for (let g = 0; g < 64 && off + 8 <= file.size; g++) {
    const h = await bytes(file, off, off + 16);
    let size = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
    const type = latin1(h, 4, 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(new DataView(h.buffer).getBigUint64(8));
      hdr = 16;
    } else if (size === 0) size = file.size - off;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return {};
      moov = await bytes(file, off + hdr, off + size);
      break;
    }
    off += size;
  }
  if (!moov) return {};
  const out = {};
  const dv = new DataView(moov.buffer);
  // Parcourt les atomes enfants de [s, e)
  const walk = (s, e, fn) => {
    let p = s;
    while (p + 8 <= e) {
      const size = dv.getUint32(p);
      const type = latin1(moov, p + 4, p + 8);
      if (size < 8 || p + size > e) break;
      fn(type, p + 8, p + size);
      p += size;
    }
  };
  walk(0, moov.length, (type, s, e) => {
    if (type === 'mvhd') {
      const v = moov[s];
      const scale = v === 1 ? dv.getUint32(s + 20) : dv.getUint32(s + 12);
      const dur = v === 1 ? Number(dv.getBigUint64(s + 24)) : dv.getUint32(s + 16);
      if (scale) out.duration = dur / scale;
    }
    if (type !== 'udta') return;
    walk(s, e, (t2, s2, e2) => {
      if (t2 !== 'meta') return;
      walk(s2 + 4, e2, (t3, s3, e3) => {
        if (t3 !== 'ilst') return;
        walk(s3, e3, (item, s4, e4) => {
          walk(s4, e4, (t5, s5, e5) => {
            if (t5 !== 'data') return;
            const kind = dv.getUint32(s5) & 0xffffff;
            const ps = s5 + 8;
            const text = () => clean(utf8(moov, ps, e5));
            if (item === '\xa9nam') out.title = text();
            else if (item === '\xa9ART') out.artist = text();
            else if (item === 'aART' && !out.artist) out.artist = text();
            else if (item === '\xa9alb') out.album = text();
            else if (item === '\xa9gen') out.genre = text();
            else if (item === 'covr' && !out.picture && e5 - ps > 64) out.picture = new Blob([moov.slice(ps, e5)], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
          });
        });
      });
    });
  });
  return out;
}

export function tagsFromFileName(name) {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .replace(/^\d{1,3}[\s.\-_]+/, '')
    .trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { title: base || name };
}

/** Durée via un élément audio (pour MP3/M4A/WAV/OGG). */
export function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      res(isFinite(d) && d > 0 ? d : 0);
    };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}
