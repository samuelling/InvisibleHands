// Invisible Hands relay: the rules, with no platform in them.
// worker.js (Cloudflare) and dev-server.mjs (Node) both wrap this file, so they cannot drift apart.
//
// The relay is deliberately dumb. It keeps a guest list for each room, checks every message against the
// limits below, stamps it with who sent it, and passes it on. It stores no values and runs no patching:
// apps describe themselves to each other, and whoever is sending decides what goes where.

export const PROTOCOL = 1;

export const LIMITS = {
  peers: 16,            // connections per room
  bytes: 32768,         // one message
  params: 128,          // parameters in one describe
  outs: 64,             // outputs in one describe or state
  points: 32,           // points in one ramp
  rampMs: 600000,       // longest ramp segment, 10 minutes
  label: 64,            // characters in an id, label, app or name
  burst: 240,           // messages a connection may send at once
  perSecond: 120,       // and how fast that allowance refills
  batch: 32,            // messages in one batch frame
  strikes: 480          // messages dropped for speed, within 30 seconds, before the connection is closed
};

// Close codes the relay uses so clients know not to keep retrying. 4000s are free for applications.
export const CLOSE = {
  key: 4001,      // this app needs a key, or the key is unknown
  denied: 4003,   // the key is revoked, or not for this website
  flood: 4008,    // far too many messages, for too long
  quota: 4029,    // the relay's monthly allowance (or this key's) is used up; try again next month
  busy: 4030      // too many new connections from one place; try again in a minute
};

const ROOM = /^[a-z0-9][a-z0-9-]{3,47}$/;
export const cleanRoom = code => { const c = String(code || '').toLowerCase(); return ROOM.test(c) ? c : null; };

// Text from one app is shown by another, so it is cut short and stripped of control characters here,
// and receivers must still treat it as plain text, never as markup.
const text = (v, fallback) => {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS.label);
  return s || fallback;
};
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : null;
const KINDS = new Set(['cont', 'toggle', 'trig']);
const BATCHABLE = new Set(['set', 'mod', 'ramp', 'state']);

export const cleanPeer = (app, name) => ({ app: text(app, 'app').toLowerCase().replace(/[^a-z0-9._-]/g, '-'), name: text(name, text(app, 'App')) });

export const newId = () => {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return Array.from(b, x => (x % 36).toString(36)).join('');
};

// Rebuild a message from only the fields the protocol knows. Anything else is dropped; a message that
// does not fit returns null. What leaves here holds numbers and short plain text, nothing more.
export function sanitize(raw) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const to = typeof m.to === 'string' ? m.to.slice(0, LIMITS.label + 4) : undefined;
  const out = { t: m.t };
  if (to && to !== '*') out.to = to;
  switch (m.t) {
    case 'set': case 'mod': {
      const p = text(m.p, null), v = m.t === 'set' ? num(m.v, 0, 1) : num(m.v, -1, 1);
      if (p === null || v === null) return null;
      out.p = p; out.v = v; return out;
    }
    case 'ramp': {
      const p = text(m.p, null);
      if (p === null || !Array.isArray(m.pts) || !m.pts.length || m.pts.length > LIMITS.points) return null;
      const pts = [];
      for (const q of m.pts) {
        if (!Array.isArray(q)) return null;
        const ms = num(q[0], 0, LIMITS.rampMs), v = num(q[1], 0, 1);
        if (ms === null || v === null) return null;
        pts.push([ms, v]);
      }
      out.p = p; out.pts = pts;
      const at = num(m.at, 0, 8.64e15); if (at !== null) out.at = at;
      return out;
    }
    case 'describe': {
      const params = [], outs = [];
      if (Array.isArray(m.params)) for (const q of m.params.slice(0, LIMITS.params)) {
        if (!q || typeof q !== 'object') continue;
        const id = text(q.id, null); if (id === null) continue;
        const e = { id: id, label: text(q.label, id), kind: KINDS.has(q.kind) ? q.kind : 'cont' };
        const v = num(q.value, 0, 1); if (v !== null) e.value = v;
        params.push(e);
      }
      if (Array.isArray(m.outs)) for (const q of m.outs.slice(0, LIMITS.outs)) {
        if (!q || typeof q !== 'object') continue;
        const id = text(q.id, null); if (id === null) continue;
        outs.push({ id: id, label: text(q.label, id) });
      }
      out.params = params; out.outs = outs; return out;
    }
    case 'state': {
      if (!m.outs || typeof m.outs !== 'object' || Array.isArray(m.outs)) return null;
      const o = {}; let n = 0;
      for (const k of Object.keys(m.outs)) {
        if (n >= LIMITS.outs) break;
        const id = text(k, null), v = num(m.outs[k], 0, 1);
        if (id === null || v === null) continue;
        o[id] = v; n++;
      }
      if (!n) return null;
      out.outs = o; return out;
    }
    case 'ping': { const n = num(m.n, 0, 1e15); return { t: 'ping', n: n === null ? 0 : n }; }
    case 'batch': {
      // several messages in one frame, to save on frames (each costs the same whatever its size).
      // Only moves and outputs may be batched; each is checked like a message of its own.
      if (!Array.isArray(m.m) || !m.m.length || m.m.length > LIMITS.batch) return null;
      const list = [];
      for (const q of m.m) {
        if (!q || typeof q !== 'object' || !BATCHABLE.has(q.t)) return null;
        const c = sanitize(q); if (!c) return null;
        list.push(c);
      }
      return { t: 'batch', m: list };
    }
    default: return null;
  }
}

// Who gets a message. roster is [{id, app}] for everyone in the room; the sender never hears itself.
// to is a peer id, "app:<name>" for every copy of one app, or nothing for everyone.
export function route(msg, fromId, roster) {
  const others = roster.filter(p => p.id !== fromId);
  if (!msg.to) return others.map(p => p.id);
  if (msg.to.slice(0, 4) === 'app:') { const a = msg.to.slice(4); return others.filter(p => p.app === a).map(p => p.id); }
  return others.filter(p => p.id === msg.to).map(p => p.id);
}

// A token bucket for each connection: bursts are fine, a flood is not. n messages at once (a batch counts each).
export function allow(bucket, now, n) {
  n = n || 1;
  if (bucket.t === undefined) { bucket.t = now; bucket.n = LIMITS.burst; }
  bucket.n = Math.min(LIMITS.burst, bucket.n + (now - bucket.t) / 1000 * LIMITS.perSecond); bucket.t = now;
  if (bucket.n < n) return false;
  bucket.n -= n; return true;
}

// Someone who keeps flooding after being told is cut off: more than LIMITS.strikes dropped within 30 seconds.
function strike(bucket, now, n) {
  if (!bucket.s0 || now - bucket.s0 > 30000) { bucket.s0 = now; bucket.dropped = 0; }
  bucket.dropped += n;
  return bucket.dropped > LIMITS.strikes;
}

// One incoming frame. Returns what to do about it: {reply} to the sender alone, {sends: [{send, to: [ids]}]},
// and {close: code} when the connection should be shut.
export function handle(raw, from, roster, bucket, now) {
  if (typeof raw !== 'string' || raw.length > LIMITS.bytes) return { reply: { t: 'error', code: 'size' } };
  const m = sanitize(raw);
  const n = m && m.t === 'batch' ? m.m.length : 1;
  if (!allow(bucket, now, n)) {
    if (strike(bucket, now, n)) return { reply: { t: 'error', code: 'flood' }, close: CLOSE.flood };
    if (!bucket.told || now - bucket.told > 1000) { bucket.told = now; return { reply: { t: 'error', code: 'rate' } }; }
    return {};
  }
  if (!m) return { reply: { t: 'error', code: 'bad' } };
  if (m.t === 'ping') return { reply: { t: 'pong', n: m.n, now: now } };
  const list = m.t === 'batch' ? m.m : [m], sends = [];
  for (const q of list) {
    const to = route(q, from.id, roster);
    delete q.to; q.from = from.id;
    if (to.length) sends.push({ send: q, to: to });
  }
  return { sends: sends };
}

// ---- who may connect ----
// House origins (the editors' own sites) need no key. Everyone else connects with ?key=, issued by the editors.
// A key is tied to the websites it may be used from, so a key copied out of a page works nowhere else.
// A key marked native may also be used with no Origin at all (Python, Go, a command line); keep those secret.
export function parseHouse(list) {
  return String(list || '').split(/[\s,]+/).filter(Boolean).map(s => s.replace(/\/+$/, '').toLowerCase());
}
export function originMatches(origin, patterns) {
  if (!origin) return false;
  const o = String(origin).toLowerCase();
  return patterns.some(p => p.endsWith(':*') ? (o === p.slice(0, -2) || o.startsWith(p.slice(0, -1))) : o === p);
}
export const KEY = /^ih_[a-z0-9]{20}$/;
// record: the key's entry, or null if there is no such key. Returns {ok, code, why, who, editor, limit}.
export function decide(origin, key, record, house) {
  if (!key) {
    if (originMatches(origin, house)) return { ok: true, who: '@' + String(origin).replace(/^https?:\/\//, '').toLowerCase(), editor: false, limit: 0 };
    return { ok: false, code: CLOSE.key, why: 'This app needs a key. Ask for one at samuelling.github.io/InvisibleHands/#key' };
  }
  if (!KEY.test(key) || !record) return { ok: false, code: CLOSE.key, why: 'That key is not one of ours.' };
  if (record.status !== 'ok') return { ok: false, code: CLOSE.denied, why: 'That key has been switched off.' };
  const fromSite = origin && origin !== 'null';
  if (fromSite ? !originMatches(origin, record.origins || []) : !record.native) {
    return { ok: false, code: CLOSE.denied, why: fromSite ? 'That key is for a different website.' : 'That key only works from its website.' };
  }
  return { ok: true, who: key, editor: !!record.editor, limit: record.editor ? 0 : (+record.monthly || 0) };
}
export const monthOf = now => new Date(now).toISOString().slice(0, 7);

export const welcome = (me, roster, now) => ({ t: 'welcome', v: PROTOCOL, batch: true, id: me.id, now: now, peers: roster.filter(p => p.id !== me.id).map(p => ({ id: p.id, app: p.app, name: p.name })) });
export const joined = me => ({ t: 'join', peer: { id: me.id, app: me.app, name: me.name } });
export const left = id => ({ t: 'leave', id: id });
