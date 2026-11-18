// Invisible Hands relay on Cloudflare: one Durable Object per room, WebSockets that hibernate when quiet.
// All the rules live in core.js; this file only connects them to Cloudflare.
//
//   wss://<this worker>/room/<code>?app=<slug>&name=<display name>

import { LIMITS, PROTOCOL, cleanRoom, cleanPeer, newId, handle, welcome, joined, left } from './core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (!m) {
      return new Response('Invisible Hands relay, protocol ' + PROTOCOL + '. Connect a WebSocket to /room/<code>.\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
    }
    const code = cleanRoom(decodeURIComponent(m[1]));
    if (!code) return new Response('Room codes are 4 to 48 characters: a to z, 0 to 9 and hyphens.\n', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('This address takes WebSocket connections.\n', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  }
};

export class Room {
  constructor(state) {
    this.state = state;
    this.buckets = new Map();   // rate limits, by peer id; forgotten when the room sleeps, which is harmless
  }

  // the guest list is whatever sockets are open; each carries its own {id, app, name}
  roster() {
    const out = [];
    for (const ws of this.state.getWebSockets()) { const a = ws.deserializeAttachment(); if (a) out.push({ id: a.id, app: a.app, name: a.name, ws: ws }); }
    return out;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.state.getWebSockets().length >= LIMITS.peers) return new Response('This room is full.\n', { status: 503 });
    const me = Object.assign({ id: newId() }, cleanPeer(url.searchParams.get('app'), url.searchParams.get('name')));
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment(me);
    const roster = this.roster();
    server.send(JSON.stringify(welcome(me, roster, Date.now())));
    const hello = JSON.stringify(joined(me));
    for (const p of roster) if (p.id !== me.id) { try { p.ws.send(hello); } catch (err) {} }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    let bucket = this.buckets.get(me.id);
    if (!bucket) { bucket = {}; this.buckets.set(me.id, bucket); }
    const roster = this.roster();
    const r = handle(typeof message === 'string' ? message : null, me, roster, bucket, Date.now());
    if (r.reply) { try { ws.send(JSON.stringify(r.reply)); } catch (err) {} }
    if (r.send && r.to.length) {
      const out = JSON.stringify(r.send), want = new Set(r.to);
      for (const p of roster) if (want.has(p.id)) { try { p.ws.send(out); } catch (err) {} }
    }
  }

  gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    this.buckets.delete(me.id);
    const bye = JSON.stringify(left(me.id));
    for (const p of this.roster()) if (p.id !== me.id) { try { p.ws.send(bye); } catch (err) {} }
  }
  webSocketClose(ws, code, reason) { this.gone(ws); try { ws.close(1000, 'bye'); } catch (err) {} }
  webSocketError(ws) { this.gone(ws); }
}
