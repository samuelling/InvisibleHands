// Invisible Hands relay on Cloudflare: one Durable Object per room, WebSockets that hibernate when quiet,
// a gate in front, and one meter that keeps the month's count so the bill has a ceiling. Anyone may connect;
// keys are optional (an app's own ceiling, or an editor's way past the relay's).
// The message rules live in core.js; this file connects them to Cloudflare.
//
//   wss://<this worker>/room/<code>?app=<slug>&name=<display name>[&key=ih_...]   (key optional)
//
// What costs money here, and what this file does about each:
//   - every incoming WebSocket frame (20 frames bill as one request): rate limits per connection, batches,
//     floods cut off, a monthly ceiling for everyone (and one for each key, for apps given one).
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
// rooms are reported to the meter by a short hash, never by their code (the code is the only way in)
async function roomTag(code) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ih-room:' + code)));
  return Array.from(h.slice(0, 5), b => b.toString(16).padStart(2, '0')).join('');
}
const LIVE_MAX = 86400000;  // a room the meter hasn't heard from in a day is assumed gone (a missed close)
const MAP_MAX = 400;        // most apps or sites the month keeps by name; the rest are counted as "(others)"
function bump(map, k, n) { if (!(k in map) && Object.keys(map).length >= MAP_MAX) k = '(others)'; map[k] = (map[k] || 0) + n; }

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

    // new connections per IP, then the key if there is one
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (env.CONNECTS && !(await env.CONNECTS.limit({ key: ip })).success) return refuse(CLOSE.busy, 'Too many new connections from here. Try again in a minute.');
    const origin = request.headers.get('Origin'), key = url.searchParams.get('key') || '';
    let record = null;
    if (key && KEY.test(key) && env.KEYS) record = await cached('k:' + key, cfg.cacheS, () => env.KEYS.get(key, 'json'));
    const d = decide(origin, key, record);
    if (!d.ok) return refuse(d.code, d.why);
    if (key && env.KEY_CONNECTS && !(await env.KEY_CONNECTS.limit({ key: key })).success) return refuse(CLOSE.busy, 'Too many new connections with this key. Try again in a minute.');

    // the month's allowance, checked against the meter at most once a minute per Worker
    const s = await cached('status', cfg.cacheS, () => meterOf(env).status(cfg.monthly));
    if (s.over && !d.editor) return refuse(CLOSE.quota, 'The relay has used its allowance for this month. It opens again on the 1st.');
    if (key && s.keysOver && s.keysOver.includes(key)) return refuse(CLOSE.quota, 'This key has used its allowance for this month.');

    // pass the decision to the room in headers the client cannot set: these overwrite anything sent
    const h = new Headers(request.headers);
    h.set('x-ih-room', await roomTag(code));
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
      { who: request.headers.get('x-ih-who') || '?', editor: !!request.headers.get('x-ih-editor'), limit: int(request.headers.get('x-ih-limit'), 0), n: 0, j: 1 });
    if (!this.tag) this.tag = request.headers.get('x-ih-room') || '?';
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment(me);
    const roster = this.roster();
    server.send(JSON.stringify(welcome(me, roster, Date.now())));
    const hello = JSON.stringify(joined(me));
    for (const p of roster) if (p.id !== me.id) { try { p.ws.send(hello); } catch (err) {} }
    await this.state.storage.put('tag', this.tag);
    await this.wake();   // so the dashboard hears about the new connection within a minute
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

  // a room reports to the meter at most once a minute, and only after something happened: frames, a join, a leave.
  // A room where nothing moves costs nothing, however long people sit in it.
  async wake() {
    if (this.alarmAt === undefined) this.alarmAt = await this.state.storage.getAlarm();
    const want = Date.now() + settings(this.env).reportMs;
    if (!this.alarmAt || this.alarmAt > want + 1000) { this.alarmAt = want; await this.state.storage.setAlarm(want); }
  }

  async alarm() {
    this.alarmAt = null;
    const tally = {}, apps = {}, present = {}, sockets = this.state.getWebSockets();
    let frames = 0, joins = 0;
    for (const ws of sockets) {
      const a = ws.deserializeAttachment(); if (!a) continue;
      present[a.app] = (present[a.app] || 0) + 1;
      if (!a.n && !a.j) continue;
      frames += a.n || 0; joins += a.j || 0;
      const t = tally[a.who] || (tally[a.who] = { n: 0, limit: a.limit || 0 }); t.n += a.n || 0;
      apps[a.app] = (apps[a.app] || 0) + (a.n || 0);
      a.n = 0; a.j = 0; ws.serializeAttachment(a);
    }
    const gone = (await this.state.storage.get('gone')) || null;   // counts from sockets that closed since the last report
    if (gone) {
      for (const who in gone.who || {}) { const g = gone.who[who], t = tally[who] || (tally[who] = { n: 0, limit: g.limit }); t.n += g.n; frames += g.n; }
      for (const app in gone.apps || {}) apps[app] = (apps[app] || 0) + gone.apps[app];
      joins += gone.joins || 0;
      await this.state.storage.delete('gone');
    }
    if (!this.tag) this.tag = (await this.state.storage.get('tag')) || '?';
    const cfg = settings(this.env);
    const s = await meterOf(this.env).report(frames, tally, cfg.monthly, { apps: apps, joins: joins, room: this.tag, sockets: sockets.length, present: present });

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
    {   // keep its last count for the next report, which also tells the dashboard it left
      const g = (await this.state.storage.get('gone')) || { who: {}, apps: {}, joins: 0 };
      if (me.n) { const t = g.who[me.who] || (g.who[me.who] = { n: 0, limit: me.limit || 0 }); t.n += me.n; g.apps[me.app] = (g.apps[me.app] || 0) + me.n; }
      g.joins += me.j || 0;
      await this.state.storage.put('gone', g);
      me.n = 0; me.j = 0; try { ws.serializeAttachment(me); } catch (err) {}
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
      if (m) await this.ctx.storage.put('last', m);   // keep last month for the dashboard
      m = { month: now, frames: 0, who: {}, over: [], apps: {}, days: {}, joins: 0, reports: 0 };
      await this.ctx.storage.put('m', m);
    }
    m.apps = m.apps || {}; m.days = m.days || {}; m.joins = m.joins || 0; m.reports = m.reports || 0;
    return m;
  }
  async report(frames, tally, monthly, extra) {
    const m = await this.month(), now = Date.now(), iso = new Date(now).toISOString();
    extra = extra || {};
    m.frames += frames; m.reports += 1; m.joins += extra.joins || 0;
    m.days[iso.slice(0, 10)] = (m.days[iso.slice(0, 10)] || 0) + frames;
    for (const a in extra.apps || {}) bump(m.apps, a, extra.apps[a]);
    // the last 48 hours, by hour
    const hours = (await this.ctx.storage.get('hours')) || {}, hk = iso.slice(0, 13);
    hours[hk] = (hours[hk] || 0) + frames;
    for (const k of Object.keys(hours)) if (now - Date.parse(k + ':00:00Z') > 48 * 3600000) delete hours[k];
    await this.ctx.storage.put('hours', hours);
    // which rooms are open right now (by hash), how many connections, which apps
    const live = (await this.ctx.storage.get('live')) || {};
    if (extra.room) { if (extra.sockets) live[extra.room] = { s: extra.sockets, apps: extra.present || {}, t: now }; else delete live[extra.room]; }
    for (const k of Object.keys(live)) if (now - live[k].t > LIVE_MAX) delete live[k];
    await this.ctx.storage.put('live', live);
    for (const src in tally) {
      // keys are always kept by name (their ceilings depend on it); a flood of distinct websites folds into one line
      const who = !(src in m.who) && Object.keys(m.who).length >= MAP_MAX && src[0] === '@' ? '@(others)' : src;
      const w = m.who[who] || (m.who[who] = { n: 0, limit: 0 });
      w.n += tally[src].n; w.limit = tally[src].limit || 0;
      if (w.limit && w.n >= w.limit && !m.over.includes(who)) m.over.push(who);
    }
    await this.ctx.storage.put('m', m);
    return { month: m.month, over: monthly > 0 && m.frames >= monthly, keysOver: m.over };
  }
  async status(monthly) {
    const m = await this.month();
    return { month: m.month, frames: m.frames, monthly: monthly, over: monthly > 0 && m.frames >= monthly, keysOver: m.over };
  }
  async usage() {
    const now = Date.now(), live = (await this.ctx.storage.get('live')) || {}, rooms = [];
    for (const k in live) if (now - live[k].t <= LIVE_MAX) rooms.push(live[k]);
    return { now: await this.month(), last: (await this.ctx.storage.get('last')) || null, hours: (await this.ctx.storage.get('hours')) || {}, live: rooms, at: now };
  }
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

  if (path === '/usage' && request.method === 'GET') {
    return json({ usage: await meterOf(env).usage(), settings: { monthly: cfg.monthly, perKey: cfg.perKey, reportSeconds: cfg.reportMs / 1000 } }, 200, cors);
  }
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
