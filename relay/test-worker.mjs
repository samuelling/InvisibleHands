// Tests for the Cloudflare side: the gate, optional keys, the meter and the monthly ceilings. Runs the real worker
// locally under `wrangler dev`, with tiny ceilings so they are reached in seconds.
//   node test-worker.mjs            (needs `npx wrangler` to work; nothing touches your Cloudflare account)

import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';
import { CLOSE } from './core.js';

const port = 8800 + Math.floor(Math.random() * 90), base = 'ws://127.0.0.1:' + port, http = 'http://127.0.0.1:' + port;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
writeFileSync('.dev.vars', 'ADMIN_TOKEN=' + TOKEN + '\n');
rmSync('.wrangler/state', { recursive: true, force: true });
const child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1',
  '--var', 'MONTHLY_FRAMES:600', '--var', 'REPORT_SECONDS:1', '--var', 'CACHE_SECONDS:0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };

function open(room, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const q = 'app=' + (opts.app || 'test') + '&name=Test' + (opts.key ? '&key=' + opts.key : '');
    const ws = new WebSocket(base + '/room/' + room + '?' + q, opts.origin ? { origin: opts.origin } : {});
    const p = { ws: ws, got: [], closed: null, welcome: null };
    p.send = o => ws.send(JSON.stringify(o));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'welcome') p.welcome = m; p.got.push(m); });
    ws.on('close', code => { p.closed = code; resolve(p); });
    ws.on('error', () => {});
    const t0 = Date.now();
    (function look() { if (p.welcome || p.closed !== null) return resolve(p); if (Date.now() - t0 > 8000) return resolve(p); setTimeout(look, 20); })();
  });
}
async function untilClosed(p, ms) { const t0 = Date.now(); while (p.closed === null && Date.now() - t0 < ms) await wait(50); return p.closed; }
const adminCall = (path, body, token) => fetch(http + '/admin' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + (token || TOKEN), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

try {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(http + '/'); if (r.ok) break; } catch (err) {} await wait(500); }
  const HOUSE = 'http://localhost:5173';

  const h = await open('room-one', { origin: HOUSE });
  ok(h.welcome && h.closed === null, 'a site connects with no key');
  const anon = await open('room-one');
  ok(anon.welcome && anon.closed === null, 'a program connects with no key');
  const stranger = await open('room-one', { origin: 'https://stranger.example' });
  ok(stranger.welcome && stranger.closed === null, 'any website connects with no key');
  const bogus = await open('room-one', { origin: 'https://stranger.example', key: 'ih_zzzzzzzzzzzzzzzzzzzz' });
  ok(bogus.closed === CLOSE.key && bogus.got.some(m => m.t === 'error' && m.why), 'a made-up key is refused, and told why');
  anon.ws.close(); stranger.ws.close();

  ok((await adminCall('/keys', null, 'wrong')).status === 401, 'the keys page needs the passphrase');
  const made = await (await adminCall('/keys', { owner: 'Friend', app: 'Their App', origins: 'https://friend.example/some/page', note: 'asked on the BBS' })).json();
  ok(/^ih_[a-z0-9]{20}$/.test(made.key) && made.origins[0] === 'https://friend.example', 'a key is issued, tied to its website (' + made.key + ')');
  const friend = await open('room-one', { origin: 'https://friend.example', key: made.key });
  ok(friend.welcome && friend.closed === null, 'the key works from its website');
  const copy = await open('room-one', { origin: 'https://copycat.example', key: made.key });
  ok(copy.closed === CLOSE.denied, 'the same key from another website is refused');
  const bare = await open('room-one', { key: made.key });
  ok(bare.closed === CLOSE.denied, 'a website key does not work with no website');
  const native = await (await adminCall('/keys', { owner: 'Script', native: true, monthly: 40 })).json();
  const py = await open('room-two', { key: native.key });
  ok(py.welcome && py.closed === null, 'a native key works with no website');

  // the per-key ceiling: 40 frames, reported every second
  for (let i = 0; i < 60; i++) py.send({ t: 'set', p: 'x', v: 0.5 });
  ok((await untilClosed(py, 5000)) === CLOSE.quota, 'a key past its monthly allowance is closed');
  const again = await open('room-two', { key: native.key });
  ok(again.closed === CLOSE.quota, '...and cannot reconnect');
  ok((await adminCall('/keys/' + native.key + '/reset', {})).ok, 'the editors can give it a fresh allowance');
  const back = await open('room-two', { key: native.key });
  ok(back.welcome && back.closed === null, '...after which it connects again');
  back.ws.close();

  ok((await adminCall('/keys/' + made.key + '/off', {})).ok, 'a key can be switched off');
  const offed = await open('room-one', { origin: 'https://friend.example', key: made.key });
  ok(offed.closed === CLOSE.denied, 'a switched-off key is refused');

  const ed = await (await adminCall('/keys', { owner: 'Sam', native: true, editor: true })).json();
  const list = await (await adminCall('/keys')).json();
  ok(list.keys.length === 3 && list.usage.now.frames > 0 && list.usage.now.who['@program'] === undefined, 'the keys page lists keys and this month\'s count (' + list.usage.now.frames + ' frames)');

  // the monthly ceiling for everyone: 600 frames
  const b = await open('room-three', { origin: HOUSE, app: 'busy' });
  for (let i = 0; i < 10; i++) { for (let k = 0; k < 70; k++) b.send({ t: 'mod', p: 'x', v: 0.1 }); await wait(600); }
  ok((await untilClosed(b, 5000)) === CLOSE.quota, 'past the monthly ceiling, open connections are closed');
  ok((await untilClosed(h, 3000)) === CLOSE.quota || h.closed === null, 'other rooms close at their next report, or stay quiet if idle');
  const late = await open('room-four', { origin: HOUSE });
  ok(late.closed === CLOSE.quota, 'and new connections are refused until next month');
  const editor = await open('room-four', { key: ed.key });
  ok(editor.welcome && editor.closed === null, 'an editor key still gets in');
  const st = await (await fetch(http + '/status')).json();
  ok(st.open === false, '/status says the relay is closed for the month');
  editor.ws.close(); friend.ws.close();
} catch (err) {
  console.log('FAIL the test run stopped: ' + (err && err.stack || err)); fails++;
}
child.kill('SIGTERM');
rmSync('.dev.vars', { force: true });
if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
