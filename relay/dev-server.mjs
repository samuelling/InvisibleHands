// A local relay for development: the same rules as the Cloudflare worker (core.js), on Node.
//   cd relay && npm install && node dev-server.mjs          -> ws://localhost:8787
//   PORT=9000 node dev-server.mjs                           -> another port

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { LIMITS, PROTOCOL, cleanRoom, cleanPeer, newId, handle, welcome, joined, left } from './core.js';

const rooms = new Map();   // code -> Map(id -> {id, app, name, ws, bucket})
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end('Invisible Hands relay (local), protocol ' + PROTOCOL + '. Connect a WebSocket to /room/<code>.\n');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.bytes * 2 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/room\/([^/]+)\/?$/), code = m && cleanRoom(decodeURIComponent(m[1]));
  const refuse = (status, why) => { socket.write('HTTP/1.1 ' + status + ' ' + why + '\r\nConnection: close\r\n\r\n'); socket.destroy(); };
  if (!code) return refuse(400, 'Bad Request');
  let room = rooms.get(code);
  if (room && room.size >= LIMITS.peers) return refuse(503, 'Room Full');
  wss.handleUpgrade(req, socket, head, ws => {
    if (!room) { room = new Map(); rooms.set(code, room); }
    const me = Object.assign({ id: newId(), ws: ws, bucket: {} }, cleanPeer(url.searchParams.get('app'), url.searchParams.get('name')));
    room.set(me.id, me);
    const roster = () => Array.from(room.values());
    const tell = (p, obj) => { try { p.ws.send(JSON.stringify(obj)); } catch (err) {} };
    tell(me, welcome(me, roster(), Date.now()));
    for (const p of roster()) if (p.id !== me.id) tell(p, joined(me));
    ws.on('message', (data, isBinary) => {
      const r = handle(isBinary ? null : data.toString('utf8'), me, roster(), me.bucket, Date.now());
      if (r.reply) tell(me, r.reply);
      if (r.send) for (const id of r.to) { const p = room.get(id); if (p) tell(p, r.send); }
    });
    const gone = () => {
      if (!room.delete(me.id)) return;
      for (const p of roster()) tell(p, left(me.id));
      if (!room.size) rooms.delete(code);
    };
    ws.on('close', gone); ws.on('error', gone);
  });
});

const port = +(process.env.PORT || 8787);
server.listen(port, () => console.log('Invisible Hands relay listening on ws://localhost:' + server.address().port));
