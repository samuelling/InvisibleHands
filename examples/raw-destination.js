// Invisible Hands without the library: a destination in plain JavaScript, about 40 lines.
// Runs in a browser, or in Node 22+:  node raw-destination.js <room> [relay]
// It offers one control, "level", and publishes one output, "wobble". See GUIDE.md for what each message means.
const room = (typeof process !== 'undefined' && process.argv[2]) || 'test-room';
const relay = (typeof process !== 'undefined' && process.argv[3]) || 'wss://invisible-hands.samuelling.workers.dev';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let level = 0.5, base = null;        // base: where "level" stood when a modulation began
const wobble = () => 0.5 + 0.5 * Math.sin(Date.now() / 500);

const ws = new WebSocket(`${relay}/room/${room}?app=raw-js&name=${encodeURIComponent('Raw JS')}`);
const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
const describe = to => send({ t: 'describe', to, params: [{ id: 'level', label: 'Level', kind: 'cont', value: level }], outs: [{ id: 'wobble', label: 'Wobble' }] });

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') describe();                         // say what we have
  if (m.t === 'join') describe(m.peer.id);                   // and again to each newcomer
  if (m.p !== 'level' || typeof m.v !== 'number' && m.t !== 'ramp') return;
  if (m.t === 'set') { level = clamp(m.v, 0, 1); base = level; }
  if (m.t === 'mod') { if (base === null) base = level; level = clamp(base + clamp(m.v, -1, 1), 0, 1); }
  if (m.t === 'ramp') level = clamp(m.pts[m.pts.length - 1][1], 0, 1);   // lazy: jump to the end (see GUIDE.md to play it)
  console.log(m.t, 'level =', level.toFixed(3));
};

let last = -1;                                               // publish the output when it changes, 15 times a second
setInterval(() => { const w = Math.round(wobble() * 1000) / 1000; if (Math.abs(w - last) > 0.002) { last = w; send({ t: 'state', outs: { wobble: w } }); } }, 66);
