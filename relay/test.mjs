// Tests for the relay, run against a live one.
//   node test.mjs                      starts the local dev server itself and tests that
//   node test.mjs ws://localhost:8787  tests a relay that is already running (wrangler dev, or the deployed one)

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { LIMITS, CLOSE, sanitize, route, decide } from './core.js';

let base = process.argv[2], child = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
if (!base) {
  const port = 8900 + Math.floor(Math.random() * 500);
  child = spawn(process.execPath, ['dev-server.mjs'], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: 'ignore' });
  base = 'ws://127.0.0.1:' + port; await wait(600);
}
const room = 'test-' + Math.random().toString(36).slice(2, 10);
let fails = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };

function peer(app, name, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + '/room/' + (code || room) + '?app=' + encodeURIComponent(app) + '&name=' + encodeURIComponent(name), { origin: 'http://localhost:5173' });   // a house origin: no key needed
    const p = { ws: ws, got: [], id: null };
    p.next = (test, ms) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function look() {
        const i = p.got.findIndex(test);
        if (i >= 0) return res(p.got.splice(i, 1)[0]);
        if (Date.now() - t0 > (ms || 2000)) return res(null);
        setTimeout(look, 10);
      })();
    });
    p.send = obj => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'welcome') { p.id = m.id; p.welcome = m; resolve(p); } else p.got.push(m); });
    ws.on('unexpected-response', (req, res) => reject(new Error('refused ' + res.statusCode)));
    ws.on('error', err => reject(err));
    ws.on('close', c => { if (!p.id) reject(new Error('closed ' + c)); });
  });
}

try {
  // ---- pure rules ----
  ok(sanitize('{"t":"set","p":"sf","v":7}').v === 1, 'set is clamped to 0..1');
  ok(sanitize('{"t":"mod","p":"sf","v":-9}').v === -1, 'mod is clamped to -1..1');
  ok(sanitize('{"t":"set","p":"sf","v":"0.5"}') === null, 'a value that is not a number is refused');
  ok(sanitize('{"t":"eval","code":"alert(1)"}') === null, 'an unknown message type is refused');
  ok(JSON.stringify(sanitize('{"t":"set","p":"sf","v":0.5,"extra":{"a":1},"html":"<b>"}')) === '{"t":"set","p":"sf","v":0.5}', 'unknown fields are dropped');
  ok(sanitize({ t: 'describe', params: [{ id: 'a\u0000b', label: 'x'.repeat(500), kind: 'weird', value: 3 }] }).params[0].label.length === LIMITS.label, 'labels are cut to ' + LIMITS.label + ' characters');
  ok(sanitize({ t: 'ramp', p: 'x', pts: new Array(LIMITS.points + 1).fill([10, 0.5]) }) === null, 'a ramp with too many points is refused');
  ok(route({ to: 'app:grove' }, 'a', [{ id: 'a', app: 'grove' }, { id: 'b', app: 'grove' }, { id: 'c', app: 'other' }]).join() === 'b', 'app: addressing reaches that app and not the sender');

  ok(sanitize({ t: 'batch', m: [{ t: 'set', p: 'a', v: 2 }, { t: 'mod', p: 'b', v: 0.1 }] }).m[0].v === 1, 'a batch is checked message by message');
  ok(sanitize({ t: 'batch', m: [{ t: 'ping', n: 1 }] }) === null && sanitize({ t: 'batch', m: new Array(LIMITS.batch + 1).fill({ t: 'set', p: 'a', v: 0 }) }) === null, 'a batch holds only moves and outputs, and not too many');
  const rec = { status: 'ok', origins: ['https://friend.example'], native: false, monthly: 5 };
  ok(decide('https://stranger.example', '', null).ok && decide(null, '', null).ok, 'no key is needed, from a website or a program');
  ok(decide('https://Stranger.example', '', null).who === '@stranger.example' && decide(null, '', null).who === '@program', 'keyless use is counted by website');
  ok(decide('https://friend.example', 'ih_aaaaaaaaaaaaaaaaaaaa', rec).ok, 'a key works from its own website');
  ok(decide('https://copycat.example', 'ih_aaaaaaaaaaaaaaaaaaaa', rec).code === CLOSE.denied, 'a copied key does not work from another website');
  ok(decide(null, 'ih_aaaaaaaaaaaaaaaaaaaa', rec).code === CLOSE.denied && decide(null, 'ih_aaaaaaaaaaaaaaaaaaaa', Object.assign({}, rec, { native: true })).ok, 'only native keys work with no website');
  ok(decide('https://friend.example', 'ih_aaaaaaaaaaaaaaaaaaaa', Object.assign({}, rec, { status: 'off' })).code === CLOSE.denied, 'a switched-off key is refused');
  ok(decide('https://friend.example', 'ih_bbbbbbbbbbbbbbbbbbbb', null).code === CLOSE.key, 'an unknown key is refused');

  // ---- a room ----
  const a = await peer('console', 'Console'), b = await peer('gaborgrove', 'Gabor Grove');
  ok(a.welcome.v === 1 && a.welcome.peers.length === 0 && typeof a.welcome.now === 'number', 'first peer is welcomed to an empty room');
  ok(b.welcome.peers.length === 1 && b.welcome.peers[0].id === a.id && b.welcome.peers[0].app === 'console', 'second peer is told who is already there');
  const j = await a.next(m => m.t === 'join');
  ok(j && j.peer.id === b.id && j.peer.name === 'Gabor Grove', 'first peer hears the second arrive');

  a.send({ t: 'set', to: b.id, p: 'spatialFreq', v: 0.25 });
  const s = await b.next(m => m.t === 'set');
  ok(s && s.from === a.id && s.p === 'spatialFreq' && s.v === 0.25 && s.to === undefined, 'a set arrives stamped with its sender');
  a.send({ t: 'set', from: 'forged', to: b.id, p: 'x', v: 0.1 });
  const f = await b.next(m => m.t === 'set');
  ok(f && f.from === a.id, 'a forged sender is overwritten');

  const c = await peer('gaborgrove', 'Second Grove');
  await a.next(m => m.t === 'join'); await b.next(m => m.t === 'join');
  a.send({ t: 'mod', to: 'app:gaborgrove', p: 'contrast', v: -0.3 });
  ok((await b.next(m => m.t === 'mod')) && (await c.next(m => m.t === 'mod')), 'app: addressing reaches both copies');
  b.send({ t: 'state', outs: { angle: 0.4, junk: 'no' } });
  const st = await a.next(m => m.t === 'state'), st2 = await c.next(m => m.t === 'state');
  ok(st && st.from === b.id && st.outs.angle === 0.4 && !('junk' in st.outs) && st2, 'state goes to everyone else, cleaned');
  ok((await b.next(m => m.t === 'state', 200)) === null, 'the sender does not hear its own message');
  a.send({ t: 'ramp', to: b.id, p: 'pullApart', pts: [[0, 0], [400, 1], [900, 0]] });
  const r = await b.next(m => m.t === 'ramp');
  ok(r && r.pts.length === 3 && r.pts[1][0] === 400, 'a ramp arrives whole');
  a.send({ t: 'batch', m: [{ t: 'set', to: b.id, p: 'one', v: 0.1 }, { t: 'mod', to: 'app:gaborgrove', p: 'two', v: 0.2 }] });
  const b1 = await b.next(m => m.t === 'set' && m.p === 'one'), b2 = await b.next(m => m.t === 'mod' && m.p === 'two'), c2 = await c.next(m => m.t === 'mod' && m.p === 'two');
  ok(b1 && b2 && c2 && b1.from === a.id && !(await c.next(m => m.p === 'one', 200)), 'a batch arrives as separate messages, each to its own address');
  a.send({ t: 'ping', n: 7 });
  const pg = await a.next(m => m.t === 'pong');
  ok(pg && pg.n === 7 && Math.abs(pg.now - Date.now()) < 60000, 'ping is answered with the relay clock');
  a.send('this is not json');
  const e = await a.next(m => m.t === 'error');
  ok(e && e.code === 'bad', 'rubbish gets an error and is not passed on');
  a.send('{"t":"set","p":"x","v":0.5,"pad":"' + 'x'.repeat(LIMITS.bytes) + '"}');
  const e2 = await a.next(m => m.t === 'error');
  ok(e2 && e2.code === 'size', 'an oversized message is refused');

  // ---- a flood ----
  b.got.length = 0;
  for (let i = 0; i < LIMITS.burst * 3; i++) a.send({ t: 'set', to: b.id, p: 'flood', v: 0.5 });
  await wait(700);
  const through = b.got.filter(m => m.p === 'flood').length;
  ok(through >= LIMITS.burst * 0.8 && through < LIMITS.burst * 2, 'a flood is cut off (' + through + ' of ' + LIMITS.burst * 3 + ' got through)');
  ok(!!(await a.next(m => m.t === 'error' && m.code === 'rate')), 'the flooder is told why');

  // ---- leaving, other rooms, a full room, bad codes ----
  c.ws.close();
  const lv = await a.next(m => m.t === 'leave');
  ok(lv && lv.id === c.id, 'the others hear a peer leave');
  const far = await peer('console', 'Elsewhere', room + '-other');
  a.send({ t: 'set', p: 'x', v: 0.9 });
  ok((await far.next(m => m.t === 'set', 300)) === null, 'rooms do not leak into each other');
  far.ws.close();
  const crowd = [];
  let refused = false;
  try { for (let i = 0; i < LIMITS.peers; i++) crowd.push(await peer('filler', 'Filler ' + i)); } catch (err) { refused = true; }
  ok(refused && crowd.length >= LIMITS.peers - 4 && crowd.length <= LIMITS.peers - 2, 'the room stops at ' + LIMITS.peers + ' peers (' + (crowd.length + 2) + ' let in; sockets still closing may count)');
  for (const p of crowd) p.ws.close();
  let bad = false;
  try { await peer('x', 'x', 'No Spaces Allowed'); } catch (err) { bad = true; }
  ok(bad, 'a malformed room code is refused');
  // a flood that keeps going is cut off
  let fl = null;
  try { fl = await peer('flooder', 'Flooder'); } catch (err) { console.log('skip the flood test: this relay limits new connections per address (' + err.message + ')'); }
  if (fl) {
    let code = 0; fl.ws.on('close', c => { code = c; });
    for (let i = 0; i < 40; i++) { for (let k = 0; k < 60; k++) fl.send({ t: 'set', p: 'x', v: 0.5 }); await wait(25); }
    await wait(300);
    ok(code === CLOSE.flood, 'a connection that keeps flooding is closed (' + code + ')');
  }
  a.ws.close(); b.ws.close();
} catch (err) {
  console.log('FAIL the test run stopped: ' + (err && err.stack || err)); fails++;
}
if (child) child.kill();
console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
