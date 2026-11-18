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
  perSecond: 120        // and how fast that allowance refills
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

// A token bucket for each connection: bursts are fine, a flood is not.
export function allow(bucket, now) {
  if (bucket.t === undefined) { bucket.t = now; bucket.n = LIMITS.burst; }
  bucket.n = Math.min(LIMITS.burst, bucket.n + (now - bucket.t) / 1000 * LIMITS.perSecond); bucket.t = now;
  if (bucket.n < 1) return false;
  bucket.n -= 1; return true;
}

// One incoming frame. Returns what to do about it: {reply} to the sender alone, or {send, to: [ids]}.
export function handle(raw, from, roster, bucket, now) {
  if (typeof raw !== 'string' || raw.length > LIMITS.bytes) return { reply: { t: 'error', code: 'size' } };
  if (!allow(bucket, now)) {
    if (!bucket.told || now - bucket.told > 1000) { bucket.told = now; return { reply: { t: 'error', code: 'rate' } }; }
    return {};
  }
  const m = sanitize(raw);
  if (!m) return { reply: { t: 'error', code: 'bad' } };
  if (m.t === 'ping') return { reply: { t: 'pong', n: m.n, now: now } };
  const to = route(m, from.id, roster);
  delete m.to; m.from = from.id;
  return { send: m, to: to };
}

export const welcome = (me, roster, now) => ({ t: 'welcome', v: PROTOCOL, id: me.id, now: now, peers: roster.filter(p => p.id !== me.id).map(p => ({ id: p.id, app: p.app, name: p.name })) });
export const joined = me => ({ t: 'join', peer: { id: me.id, app: me.app, name: me.name } });
export const left = id => ({ t: 'leave', id: id });
