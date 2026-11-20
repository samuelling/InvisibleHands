// Invisible Hands relay on Cloudflare: one Durable Object per room, WebSockets that hibernate when quiet,
// a gate in front that checks keys, and one meter that keeps the month's count so the bill has a ceiling.
// The message rules live in core.js; this file connects them to Cloudflare.
//
//   wss://<this worker>/room/<code>?app=<slug>&name=<display name>[&key=ih_...]
//
// What costs money here, and what this file does about each:
//   - every incoming WebSocket frame (20 frames bill as one request): rate limits per connection, batches,
//     floods cut off, a monthly ceiling for everyone and a smaller one for each key.
//   - every new connection (one Worker request, one Durable Object request): a per-IP and a per-key limit
//     on new connections, and refusals answered here in the Worker without waking any room.
//   - time a room is awake: the Hibernation API, no timers in rooms, and an alarm only while a room is busy.

import { DurableObject } from 'cloudflare:workers';
import { LIMITS, PROTOCOL, CLOSE, KEY, cleanRoom, cleanPeer, newId, handle, welcome, joined, left, decide, parseHouse, originMatches, monthOf } from './core.js';

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, extra || {}) });
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

// small caches in this Worker's memory, so a busy app doesn't cost a KV read or a meter call per connection
const cache = new Map();
async function cached(key, seconds, load) {
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.t < seconds * 1000) return hit.v;
  const v = await load();
  cache.set(key, { t: now, v: v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

// A refusal is a WebSocket that opens, says why, and closes with a code the client knows not to retry.
// (A plain HTTP error reaches browser code only as "the connection failed", which clients retry forever.)
function refuse(code, why) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ t: 'error', code: code === CLOSE.quota ? 'quota' : code === CLOSE.busy ? 'busy' : 'key', why: why }));
  pair[1].close(code, why.slice(0, 120));
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function settings(env) {
  return {
    house: parseHouse(env.HOUSE_ORIGINS),
    monthly: int(env.MONTHLY_FRAMES, 18000000),       // for everyone together; 18M frames bill as 900k requests
    perKey: int(env.KEY_MONTHLY_FRAMES, 2000000),     // default for one key
    reportMs: int(env.REPORT_SECONDS, 60) * 1000,     // how often a busy room tells the meter
    cacheS: int(env.CACHE_SECONDS, 60)
  };
}
const meterOf = env => env.METER.get(env.METER.idFromName('meter'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url), cfg = settings(env);
    if (url.pathname.startsWith('/admin/')) return admin(request, env, url, cfg);
    if (url.pathname === '/status') {
      const s = await cached('status', cfg.cacheS, () => meterOf(env).status(cfg.monthly));
      return json({ protocol: PROTOCOL, open: !s.over, month: s.month }, 200, { 'access-control-allow-origin': '*' });
    }
    const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (!m) return new Response('Invisible Hands relay, protocol ' + PROTOCOL + '. Connect a WebSocket to /room/<code>.\n', { headers: Object.assign({ 'access-control-allow-origin': '*' }, TEXT) });
    const code = cleanRoom(decodeURIComponent(m[1]));
    if (!code) return new Response('Room codes are 4 to 48 characters: a to z, 0 to 9 and hyphens.\n', { status: 400, headers: TEXT });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('This address takes WebSocket connections.\n', { status: 426, headers: TEXT });

    // new connections per IP, then the key
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (env.CONNECTS && !(await env.CONNECTS.limit({ key: ip })).success) return refuse(CLOSE.busy, 'Too many new connections from here. Try again in a minute.');
    const origin = request.headers.get('Origin'), key = url.searchParams.get('key') || '';
    let record = null;
    if (key && KEY.test(key) && env.KEYS) record = await cached('k:' + key, cfg.cacheS, () => env.KEYS.get(key, 'json'));
    const d = decide(origin, key, record, cfg.house);
    if (!d.ok) return refuse(d.code, d.why);
    if (key && env.KEY_CONNECTS && !(await env.KEY_CONNECTS.limit({ key: key })).success) return refuse(CLOSE.busy, 'Too many new connections with this key. Try again in a minute.');

    // the month's allowance, checked against the meter at most once a minute per Worker
    const s = await cached('status', cfg.cacheS, () => meterOf(env).status(cfg.monthly));
    if (s.over && !d.editor) return refuse(CLOSE.quota, 'The relay has used its allowance for this month. It opens again on the 1st.');
    if (key && s.keysOver && s.keysOver.includes(key)) return refuse(CLOSE.quota, 'This key has used its allowance for this month.');

    // pass the decision to the room in headers the client cannot set: these overwrite anything sent
    const h = new Headers(request.headers);
    h.set('x-ih-who', d.who); h.set('x-ih-editor', d.editor ? '1' : ''); h.set('x-ih-limit', String(d.limit || (key && !d.editor ? cfg.perKey : 0)));
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers: h }));
  }
};

export class Room {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.buckets = new Map();   // rate limits, by peer id; forgotten when the room sleeps, which is harmless
    this.alarmSet = null;       // unknown after waking; looked up once
  }

  // the guest list is whatever sockets are open; each carries its own {id, app, name, who, editor, limit, n}
  roster() {
    const out = [];
    for (const ws of this.state.getWebSockets()) { const a = ws.deserializeAttachment(); if (a) out.push(Object.assign({ ws: ws }, a)); }
    return out;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.state.getWebSockets().length >= LIMITS.peers) return refuse(CLOSE.busy, 'This room is full.');
    const me = Object.assign({ id: newId() }, cleanPeer(url.searchParams.get('app'), url.searchParams.get('name')),
      { who: request.headers.get('x-ih-who') || '?', editor: !!request.headers.get('x-ih-editor'), limit: int(request.headers.get('x-ih-limit'), 0), n: 0 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment(me);
    const roster = this.roster();
    server.send(JSON.stringify(welcome(me, roster, Date.now())));
    const hello = JSON.stringify(joined(me));
    for (const p of roster) if (p.id !== me.id) { try { p.ws.send(hello); } catch (err) {} }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    // count the frame on the socket itself: the count survives hibernation, and costs no storage write
    me.n = (me.n || 0) + 1; ws.serializeAttachment(me);
    let bucket = this.buckets.get(me.id);
    if (!bucket) { bucket = {}; this.buckets.set(me.id, bucket); }
    const roster = this.roster();
    const r = handle(typeof message === 'string' ? message : null, me, roster, bucket, Date.now());
    if (r.reply) { try { ws.send(JSON.stringify(r.reply)); } catch (err) {} }
    if (r.sends) for (const s of r.sends) {
      const out = JSON.stringify(s.send), want = new Set(s.to);
      for (const p of roster) if (want.has(p.id)) { try { p.ws.send(out); } catch (err) {} }
    }
    if (r.close) { try { ws.close(r.close, 'too many messages'); } catch (err) {} }
    await this.wake();
  }

  // a busy room reports to the meter once a minute; a quiet room sets no alarm at all
  async wake() {
    if (this.alarmSet === null) this.alarmSet = (await this.state.storage.getAlarm()) !== null;
    if (!this.alarmSet) { this.alarmSet = true; await this.state.storage.setAlarm(Date.now() + settings(this.env).reportMs); }
  }

  async alarm() {
    this.alarmSet = false;
    const tally = {}, sockets = this.state.getWebSockets();
    let frames = 0;
    for (const ws of sockets) {
      const a = ws.deserializeAttachment(); if (!a || !a.n) continue;
      frames += a.n;
      const t = tally[a.who] || (tally[a.who] = { n: 0, limit: a.limit || 0 }); t.n += a.n;
      a.n = 0; ws.serializeAttachment(a);
    }
    const gone = (await this.state.storage.get('gone')) || null;   // counts from sockets that closed since the last report
    if (gone) {
      for (const who in gone) { const t = tally[who] || (tally[who] = { n: 0, limit: gone[who].limit }); t.n += gone[who].n; frames += gone[who].n; }
      await this.state.storage.delete('gone');
    }
    if (!frames) return;
    const cfg = settings(this.env);
    const s = await meterOf(this.env).report(frames, tally, cfg.monthly);
    // over the line: let the people in this room know, and close the connections that no longer qualify
    for (const ws of sockets) {
      const a = ws.deserializeAttachment(); if (!a) continue;
      const keyOver = s.keysOver.includes(a.who), allOver = s.over && !a.editor;
      if (keyOver || allOver) {
        try { ws.send(JSON.stringify({ t: 'error', code: 'quota' })); ws.close(CLOSE.quota, 'monthly allowance used'); } catch (err) {}
      }
    }
  }

  async gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    this.buckets.delete(me.id);
    if (me.n) {   // keep its last count for the next report
      const g = (await this.state.storage.get('gone')) || {};
      const t = g[me.who] || (g[me.who] = { n: 0, limit: me.limit || 0 }); t.n += me.n;
      await this.state.storage.put('gone', g);
      me.n = 0; try { ws.serializeAttachment(me); } catch (err) {}
      await this.wake();
    }
    const bye = JSON.stringify(left(me.id));
    for (const p of this.roster()) if (p.id !== me.id) { try { p.ws.send(bye); } catch (err) {} }
  }
  async webSocketClose(ws, code, reason) { await this.gone(ws); try { ws.close(1000, 'bye'); } catch (err) {} }
  async webSocketError(ws) { await this.gone(ws); }
}

// One meter for the whole relay. It keeps this month's frame count, overall and for each key (and each house
// site), and says when a ceiling is reached. Rooms report to it once a minute while busy; nothing else writes.
export class Meter extends DurableObject {
  async month() {
    const now = monthOf(Date.now());
    let m = await this.ctx.storage.get('m');
    if (!m || m.month !== now) {
      if (m) await this.ctx.storage.put('last', m);   // keep last month for the keys page
      m = { month: now, frames: 0, who: {}, over: [] };
      await this.ctx.storage.put('m', m);
    }
    return m;
  }
  async report(frames, tally, monthly) {
    const m = await this.month();
    m.frames += frames;
    for (const who in tally) {
      const w = m.who[who] || (m.who[who] = { n: 0, limit: 0 });
      w.n += tally[who].n; w.limit = tally[who].limit || 0;
      if (w.limit && w.n >= w.limit && !m.over.includes(who)) m.over.push(who);
    }
    await this.ctx.storage.put('m', m);
    return { month: m.month, over: monthly > 0 && m.frames >= monthly, keysOver: m.over };
  }
  async status(monthly) {
    const m = await this.month();
    return { month: m.month, frames: m.frames, monthly: monthly, over: monthly > 0 && m.frames >= monthly, keysOver: m.over };
  }
  async usage() { return { now: await this.month(), last: (await this.ctx.storage.get('last')) || null }; }
  async unblock(who) { const m = await this.month(); m.over = m.over.filter(x => x !== who); if (m.who[who]) m.who[who].n = 0; await this.ctx.storage.put('m', m); return true; }
}

// ---- the editors' keys page talks to these. Bearer ADMIN_TOKEN (a Worker secret). ----
function same(a, b) {   // compare without leaking how much matched
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function newKey() {
  const b = new Uint8Array(20); crypto.getRandomValues(b);
  return 'ih_' + Array.from(b, x => (x % 36).toString(36)).join('');
}
const cleanOrigin = o => { try { const u = new URL(String(o).trim()); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin.toLowerCase() : null; } catch (err) { return null; } };
const short = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n || 200);

async function admin(request, env, url, cfg) {
  const origin = request.headers.get('Origin');
  const cors = originMatches(origin, cfg.house) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' } : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || !same(auth, env.ADMIN_TOKEN)) return json({ error: 'Wrong passphrase.' }, 401, cors);
  if (!env.KEYS) return json({ error: 'No KEYS namespace is bound.' }, 500, cors);
  const path = url.pathname.replace(/^\/admin/, '');

  if (path === '/keys' && request.method === 'GET') {
    const list = await env.KEYS.list({ limit: 1000 }), out = [];
    for (const k of list.keys) { const r = await env.KEYS.get(k.name, 'json'); if (r) out.push(Object.assign({ key: k.name }, r)); }
    const use = await meterOf(env).usage();
    return json({ keys: out, usage: use, settings: { monthly: cfg.monthly, perKey: cfg.perKey, house: cfg.house } }, 200, cors);
  }
  if (path === '/keys' && request.method === 'POST') {
    let b; try { b = await request.json(); } catch (err) { return json({ error: 'Send JSON.' }, 400, cors); }
    const origins = (Array.isArray(b.origins) ? b.origins : String(b.origins || '').split(/[\s,]+/)).map(cleanOrigin).filter(Boolean).slice(0, 8);
    if (!origins.length && !b.native) return json({ error: 'Give at least one website (https://…), or tick "no website".' }, 400, cors);
    const key = newKey(), rec = { owner: short(b.owner, 80), app: short(b.app, 80), note: short(b.note, 400), origins: origins,
      native: !!b.native, editor: !!b.editor, monthly: int(b.monthly, cfg.perKey), status: 'ok', made: new Date().toISOString() };
    await env.KEYS.put(key, JSON.stringify(rec));
    return json(Object.assign({ key: key }, rec), 200, cors);
  }
  const k = path.match(/^\/keys\/(ih_[a-z0-9]{20})\/(off|on|reset)$/);
  if (k && request.method === 'POST') {
    const rec = await env.KEYS.get(k[1], 'json');
    if (!rec) return json({ error: 'No such key.' }, 404, cors);
    if (k[2] === 'reset') { await meterOf(env).unblock(k[1]); return json({ ok: true }, 200, cors); }
    rec.status = k[2] === 'off' ? 'off' : 'ok';
    await env.KEYS.put(k[1], JSON.stringify(rec));
    return json(Object.assign({ key: k[1] }, rec), 200, cors);
  }
  return json({ error: 'Not here.' }, 404, cors);
}
