/* The demos on the front page. Three real apps (the Blot, the Pendulum and the Hand) join one room on the
   real relay, exactly as apps on three different computers would. Demo 3 is a drawing; nothing is sent.
   To save the relay's allowance, nothing connects until "Plug them in", and the page unplugs itself when
   it is hidden for a minute or left alone for six. ?relay=ws://localhost:8787 tries a local relay. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var RELAY = q.get('relay') || undefined;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dark = function () { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches; };
  var css = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // ---------------------------------------------------------------- the wire: what the Blot hears and says
  var RealWS = window.WebSocket, lines = [], lastKey = '', wireDue = false;
  function slim(m) {
    if (m.t === 'describe') return { t: 'describe', params: (m.params || []).map(function (p) { return p.id; }), outs: (m.outs || []).map(function (o) { return o.id; }) };
    if (m.t === 'welcome') return { t: 'welcome', id: m.id, peers: (m.peers || []).length };
    if (m.t === 'state') { var o = {}; for (var k in m.outs) o[k] = Math.round(m.outs[k] * 100) / 100; return { t: 'state', outs: o }; }
    if (typeof m.v === 'number') { var c = {}; for (var j in m) c[j] = m[j]; c.v = Math.round(m.v * 100) / 100; return c; }
    return m;
  }
  function logWire(dir, raw) {
    var m; try { m = JSON.parse(raw); } catch (err) { return; }
    var list = m.t === 'batch' ? m.m : [m];
    list.forEach(function (x) {
      if (x.t === 'ping' || x.t === 'pong') return;
      var key = dir + x.t + (x.p || ''), text = JSON.stringify(slim(x));
      if (key === lastKey && lines.length) { lines[lines.length - 1].n++; lines[lines.length - 1].text = text; }
      else { lines.push({ dir: dir, text: text, n: 1 }); lastKey = key; if (lines.length > 6) lines.shift(); }
    });
    if (!wireDue) { wireDue = true; requestAnimationFrame(drawWire); }
  }
  function drawWire() {
    wireDue = false;
    var w = $('wire'); w.textContent = '';
    lines.forEach(function (l) {
      var s = el('span', l.dir === 'in' ? 'i' : 'o', (l.dir === 'in' ? '← heard ' : '→ said  ') + l.text + (l.n > 1 ? '  ×' + l.n : '') + '\n');
      w.appendChild(s);
    });
  }
  window.WebSocket = function (url, protocols) {
    var ws = protocols ? new RealWS(url, protocols) : new RealWS(url);
    try {
      if (new URL(url).searchParams.get('app') === 'blot') {
        var send = ws.send.bind(ws);
        ws.send = function (d) { logWire('out', d); return send(d); };
        ws.addEventListener('message', function (e) { logWire('in', e.data); });
      }
    } catch (err) {}
    return ws;
  };
  window.WebSocket.prototype = RealWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) { window.WebSocket[k] = i; });

  // ---------------------------------------------------------------- the Blot: a two-ink halftone
  var B = { size: 0.55, wobble: 0.35, mis: 0.3, grain: 0.45, spin: 0.25 };
  var BP = [['size', 'Size'], ['wobble', 'Wobble'], ['mis', 'Misregister'], ['grain', 'Grain'], ['spin', 'Spin']];
  var splat = 0, splatHigh = false, spinA = 0, breath = 0.5, blotHands = null;
  var own = {}, ownName = {}, ownTags = [];
  BP.forEach(function (p) {
    var row = el('div', 'ctl'), n = el('span', 'n', p[1]), s = el('input');
    s.type = 'range'; s.min = 0; s.max = 1000; s.value = Math.round(B[p[0]] * 1000); s.setAttribute('aria-label', 'Blot ' + p[1]);
    s.addEventListener('input', function () { B[p[0]] = s.value / 1000; if (blotHands) blotHands.recenter(p[0]); poke(); });
    row.append(n, s); $('own').appendChild(row); own[p[0]] = s; ownName[p[0]] = n;
  });
  $('allow').addEventListener('change', function () { if (blotHands) blotHands.allow = $('allow').checked; });

  function fit(c) {
    var r = c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return d;
  }
  function drawBlot(t, dt) {
    var c = $('blot'), d = fit(c), g = c.getContext('2d'), W = c.width, H = c.height;
    g.globalCompositeOperation = 'source-over'; g.fillStyle = css('--paper'); g.fillRect(0, 0, W, H);
    spinA += (B.spin - 0.1) * dt * 1.6;
    splat *= Math.pow(0.12, dt);
    var pitch = (4 + B.grain * 13) * d, R0 = Math.min(W, H) * (0.12 + 0.24 * B.size), blend = dark() ? 'screen' : 'multiply';
    function layer(color, ang, ox, oy, ph) {
      g.globalCompositeOperation = blend; g.fillStyle = color; g.beginPath();
      var cx = W / 2 + ox, cy = H / 2 + oy, a = ang + spinA, co = Math.cos(a), si = Math.sin(a);
      var Rmax = R0 * (1 + B.wobble * 0.45 + splat * 0.6) * 1.05, n = Math.ceil(Rmax / pitch);
      for (var i = -n; i <= n; i++) for (var j = -n; j <= n; j++) {
        var u = i * pitch, v = j * pitch, x = cx + u * co - v * si, y = cy + u * si + v * co;
        var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), th = Math.atan2(dy, dx);
        var R = R0 * (1 + B.wobble * 0.45 * (0.6 * Math.sin(3 * th + t * 1.3 + ph) + 0.4 * Math.sin(5 * th - t * 0.8 + 2 * ph)) + splat * 0.6 * Math.max(0, Math.sin(9 * th + 3 * ph)));
        var k = (R - r) / (R * 0.55);
        if (k <= 0) continue;
        var rad = pitch * 0.55 * Math.sqrt(Math.min(1, k));
        g.moveTo(x + rad, y); g.arc(x, y, rad, 0, 6.2832);
      }
      g.fill();
    }
    layer(css('--teal'), 0.26, 0, 0, 0);
    layer(css('--flame'), 1.31, B.mis * 0.09 * W, B.mis * 0.06 * H, 1.7);
    g.globalCompositeOperation = 'source-over';
    breath = 0.5 + 0.5 * Math.sin(t * 1.1);
    BP.forEach(function (p) { var s = own[p[0]]; if (document.activeElement !== s) s.value = Math.round(B[p[0]] * 1000); });
  }

  // ---------------------------------------------------------------- the Pendulum: has an output
  var P = { len: 0.5, ink: 0 }, phase = 0, amp = 0.75, pushHigh = false, swing = 0.5;
  function stepPend(dt) {
    var L = 0.4 + 0.55 * P.len, T = 0.9 + 1.6 * Math.sqrt(L);   // longer swings slower, as they should
    phase += dt * 2 * Math.PI / T;
    amp += (0.75 - amp) * (1 - Math.pow(0.4, dt));
    swing = clamp(0.5 + 0.5 * amp * Math.sin(phase) / 1.25, 0, 1);
    return L;
  }
  function drawPend(t, dt) {
    var c = $('pend'), d = fit(c), g = c.getContext('2d'), W = c.width, H = c.height;
    g.fillStyle = css('--paper'); g.fillRect(0, 0, W, H);
    var L = stepPend(dt);
    var th = amp * Math.sin(phase), px = W / 2, py = H * 0.08, len = H * 0.82 * L, bx = px + len * Math.sin(th), by = py + len * Math.cos(th);
    g.lineCap = 'round';
    function draw(col, ox, oy) {
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 3 * d;
      g.beginPath(); g.moveTo(px + ox, py + oy); g.lineTo(bx + ox, by + oy); g.stroke();
      g.beginPath(); g.arc(bx + ox, by + oy, H * 0.07, 0, 6.2832); g.fill();
    }
    g.globalCompositeOperation = dark() ? 'screen' : 'multiply';
    draw(P.ink > 0.5 ? css('--flame') : css('--teal'), 0, 0);
    draw(P.ink > 0.5 ? css('--teal') : css('--flame'), 4 * d, 3 * d);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = css('--toner'); g.fillRect(px - 40 * d, py - 3 * d, 80 * d, 6 * d);
    g.fillStyle = css('--muted'); g.font = '700 ' + 11 * d + 'px "Courier Prime", monospace';
    g.fillText('swing ' + swing.toFixed(2), 10 * d, H - 10 * d);
  }

  // ---------------------------------------------------------------- the Hand: a source built from what it hears
  var hand = null, pendHands = null, swings = new Map(), H = { rate: 0.5, depth: 0.6 }, toggles = {};
  function settings() {
    H.rate = 0.05 * Math.pow(60, $('rate').value / 100);
    H.depth = $('depth').value / 100;
    $('rate-o').textContent = H.rate < 1 ? H.rate.toFixed(2) + ' Hz' : H.rate.toFixed(1) + ' Hz';
    $('depth-o').textContent = Math.round(H.depth * 100) + '%';
  }
  $('rate').addEventListener('input', settings); $('depth').addEventListener('input', settings); settings();

  function renderHand() {
    var box = $('hand'); box.textContent = '';
    if (!hand || hand.status !== 'on') {
      box.appendChild(el('p', 'hand-empty', hand && hand.error ? hand.error : 'Plug them in. The Hand has never heard of the Blot: everything below arrives from the Blot itself, as a list of its controls.'));
      return;
    }
    var others = [];
    hand.peers.forEach(function (peer) {
      if (!peer.params.length) { others.push(peer.name); return; }
      box.appendChild(el('p', 'kind', peer.name + ' · ' + peer.params.length + ' controls'));
      peer.params.forEach(function (p) {
        var row = el('div', 'ctl'), n = el('span', 'n', p.label);
        var key = peer.id + '/' + p.id;
        if (p.kind === 'trig') {
          var fire = el('button', 'btn small', 'Fire'); fire.type = 'button';
          fire.onclick = function () { hand.ramp(peer.id, p.id, [[0, 1], [120, 0]]); poke(); };
          row.append(n, el('span'), fire, el('span'));
        } else if (p.kind === 'toggle') {
          var flip = el('button', 'btn small', 'Flip'); flip.type = 'button';
          flip.onclick = function () { toggles[key] = !toggles[key]; hand.set(peer.id, p.id, toggles[key] ? 1 : 0); poke(); };
          row.append(n, el('span'), flip, el('span'));
        } else {
          var s = el('input'); s.type = 'range'; s.min = 0; s.max = 1000; s.value = Math.round((p.value || 0) * 1000); s.setAttribute('aria-label', 'Set ' + p.label + ' on ' + peer.name);
          var last = 0, timer = 0, push = function () { last = performance.now(); hand.set(peer.id, p.id, s.value / 1000); };
          s.addEventListener('input', function () { poke(); clearTimeout(timer); var w = 40 - (performance.now() - last); if (w <= 0) push(); else timer = setTimeout(push, w); });
          var sw = el('button', 'btn small', 'Swing'); sw.type = 'button'; sw.setAttribute('aria-pressed', String(swings.has(key)));
          sw.onclick = function () {
            if (swings.has(key)) { swings.delete(key); hand.mod(peer.id, p.id, 0); } else swings.set(key, { peer: peer.id, p: p.id, t0: performance.now() / 1000 });
            sw.setAttribute('aria-pressed', String(swings.has(key))); poke();
          };
          var env = el('button', 'btn small', 'Env'); env.type = 'button';
          env.onclick = function () { hand.ramp(peer.id, p.id, [[80, 1], [700, p.value || 0.3]], hand.serverNow() + 80); poke(); };
          row.append(n, s, sw, env);
        }
        box.appendChild(row);
      });
    });
    if (others.length) box.appendChild(el('p', 'small', 'Also in the room: ' + others.join(', ') + '. Hands without knobs of their own.'));
  }

  // one timer for every swing and every patch cable, so a tick's moves leave together as one frame
  var tickTimer = 0;
  function tick() {
    if (!hand || hand.status !== 'on') return;
    var now = performance.now() / 1000;
    swings.forEach(function (s, key) {
      if (!hand.peers.some(function (p) { return p.id === s.peer; })) { swings.delete(key); return; }
      hand.mod(s.peer, s.p, 0.35 * Math.sin(2 * Math.PI * H.rate * (now - s.t0)));
    });
    var pend = hand.peers.find(function (p) { return p.app === 'pendulum'; }), blot = hand.peers.find(function (p) { return p.app === 'blot'; });
    var ps = pend && pend.state.swing, bb = blot && blot.state.breath;
    if (typeof ps === 'number' && blot) {
      if ($('p1').checked) hand.mod(blot.id, 'size', (ps - 0.5) * H.depth);
      if ($('p2').checked) hand.mod(blot.id, 'mis', (ps - 0.5) * H.depth * 1.4);
    }
    if (typeof bb === 'number' && pend && $('p3').checked) hand.mod(pend.id, 'len', (bb - 0.5) * H.depth);
  }
  [['p1', 'size', 'blot'], ['p2', 'mis', 'blot'], ['p3', 'len', 'pendulum']].forEach(function (c) {
    $(c[0]).addEventListener('change', function () {
      poke();
      if (!$(c[0]).checked && hand) { var t = hand.peers.find(function (p) { return p.app === c[2]; }); if (t) hand.mod(t.id, c[1], 0); }
    });
  });

  // ---------------------------------------------------------------- plugging in and out
  var room = null, lastPoke = Date.now(), hiddenAt = 0, flashT = 0;
  function poke() { lastPoke = Date.now(); }
  ['pointerdown', 'keydown', 'input'].forEach(function (e) { document.addEventListener(e, poke, true); });

  function status() {
    var s = hand ? hand.status : 'off';
    $('dot').className = 'dot' + (s === 'on' ? ' on' : s === 'connecting' || s === 'retrying' ? ' wait' : '');
    $('st').textContent = s === 'on' ? 'Linked through the relay. Three apps in one room.' : s === 'connecting' ? 'Connecting…' : s === 'retrying' ? 'Reconnecting…' : s === 'error' ? (hand.error || 'The relay said no.') : (room === false ? 'Unplugged to save the relay’s allowance. Plug in again any time.' : 'Not linked. Nothing has been sent.');
    $('plug').textContent = hand ? 'Unplug' : 'Plug them in';
    $('roomline').hidden = !hand; $('room').textContent = room || '';
    $('bay-note').textContent = s === 'on' ? 'Tick a cable. The Hand listens to one app’s output and swings another app’s knob with it.' : 'Plug them in up top first.';
    renderHand();
  }
  function plug() {
    room = InvisibleHands.makeCode();
    var base = { relay: RELAY, autoJoin: false };
    blotHands = InvisibleHands.create(Object.assign({}, base, {
      app: 'blot', name: 'The Blot', stateHz: 6,
      params: BP.map(function (p) { return { id: p[0], label: p[1], get: function () { return B[p[0]]; }, set: function (v) { B[p[0]] = v; } }; })
        .concat([{ id: 'splat', label: 'Splat', kind: 'trig', get: function () { return 0; }, set: function (v) { if (v > 0.5 && !splatHigh) splat = 1; splatHigh = v > 0.5; } }]),
      outs: [{ id: 'breath', label: 'Breath', get: function () { return breath; } }]
    }));
    blotHands.allow = $('allow').checked;
    // the Invisible Hands mark, tacked onto each of the Blot's own sliders
    BP.forEach(function (p) { var t = blotHands.tag(p[0]); ownName[p[0]].appendChild(t); ownTags.push(t); });
    blotHands.on('in', function () { var c = $('blot-clip'), now = performance.now(); if (now - flashT > 250) { flashT = now; c.classList.add('hit'); setTimeout(function () { c.classList.remove('hit'); }, 120); } });
    pendHands = InvisibleHands.create(Object.assign({}, base, {
      app: 'pendulum', name: 'The Pendulum', stateHz: 6,
      params: [
        { id: 'len', label: 'Length', get: function () { return P.len; }, set: function (v) { P.len = v; } },
        { id: 'push', label: 'Push', kind: 'trig', get: function () { return 0; }, set: function (v) { if (v > 0.5 && !pushHigh) amp = 1.25; pushHigh = v > 0.5; } },
        { id: 'ink', label: 'Ink', kind: 'toggle', get: function () { return P.ink; }, set: function (v) { P.ink = v > 0.5 ? 1 : 0; } }
      ],
      outs: [{ id: 'swing', label: 'Swing', get: function () { return swing; } }]
    }));
    hand = InvisibleHands.create(Object.assign({}, base, { app: 'demo-hand', name: 'The Hand' }));
    hand.on('status', status); hand.on('peers', renderHand);
    blotHands.join(room); pendHands.join(room); hand.join(room);
    clearInterval(tickTimer); tickTimer = setInterval(tick, 50);
    makeQR(); lastPoke = Date.now(); status();
  }
  function unplug(why) {
    clearInterval(tickTimer); swings.clear();
    [blotHands, pendHands, hand].forEach(function (h) { if (h) h.leave(); });
    ownTags.forEach(function (t) { t.remove(); }); ownTags = [];
    blotHands = pendHands = hand = null; room = why ? false : null;
    $('qr').innerHTML = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><text x="5" y="5.6" font-size="1.3" text-anchor="middle" font-family="Courier Prime, monospace" fill="#18181B">plug in first</text></svg>';
    $('phone-link').textContent = ''; $('copy-phone').disabled = true;
    status();
  }
  $('plug').addEventListener('click', function () { if (hand) unplug(false); else plug(); });
  document.addEventListener('visibilitychange', function () { hiddenAt = document.hidden ? Date.now() : 0; });
  setInterval(function () {
    if (!hand) return;
    if ((hiddenAt && Date.now() - hiddenAt > 60000) || Date.now() - lastPoke > 6 * 60000) unplug(true);
  }, 5000);

  // ---------------------------------------------------------------- the phone: a QR code for the console
  function consoleUrl() {
    var u = new URL('console/', location.href);
    u.searchParams.set('room', room);
    if (RELAY) u.searchParams.set('relay', RELAY);
    return u.toString();
  }
  function makeQR() {
    var url = consoleUrl(), qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    var n = qr.getModuleCount(), m = 2, rects = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) rects += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
    $('qr').innerHTML = '<svg viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + rects + '" fill="#18181B"/></svg>';
    $('phone-link').textContent = url; $('copy-phone').disabled = false;
  }
  $('copy-phone').addEventListener('click', function () {
    var b = $('copy-phone');
    if (navigator.clipboard) navigator.clipboard.writeText(consoleUrl()).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy the link'; }, 1400); });
  });

  // ---------------------------------------------------------------- demo 3: the bumpy road (a drawing)
  var sim = null;
  function fire() {
    var J = $('jit').value * 2, base = 40, sendAt = 100, att = 80, dec = 600, step = 33;
    var e = function (t) { t -= sendAt; return t < 0 ? 0 : t < att ? t / att : t < att + dec ? 1 - (t - att) / dec : 0; };
    var delay = function () { return base + J * -Math.log(1 - Math.random() * 0.98) * 0.6; };
    var arrivals = [], prev = 0;
    for (var t = sendAt; t <= sendAt + att + dec + step; t += step) { var a = Math.max(prev, t + delay()); arrivals.push([a, e(t)]); prev = a; }
    var rampAt = Math.max(sendAt + base + 40, sendAt + delay());
    sim = { e: e, arrivals: arrivals, rampAt: rampAt, att: att, dec: dec, t0: performance.now(), span: 1500 };
  }
  function drawSim(now) {
    var c = $('sim'), d = fit(c), g = c.getContext('2d'), W = c.width, Hh = c.height;
    g.fillStyle = css('--paper'); g.fillRect(0, 0, W, Hh);
    g.strokeStyle = css('--rule'); g.lineWidth = d;
    for (var gx = 0; gx <= 1500; gx += 250) { var X = gx / 1500 * W; g.beginPath(); g.moveTo(X, 0); g.lineTo(X, Hh); g.stroke(); }
    g.fillStyle = css('--muted'); g.font = '400 ' + 10 * d + 'px "Courier Prime", monospace';
    for (gx = 0; gx <= 1250; gx += 250) g.fillText(gx + ' ms', gx / 1500 * W + 4 * d, Hh - 6 * d);
    if (!sim) { g.fillStyle = css('--muted'); g.font = '700 ' + 13 * d + 'px "Courier Prime", monospace'; g.fillText('Press “Send an envelope”.', 14 * d, Hh / 2); return; }
    var shown = reduce ? 1500 : Math.min(1500, (now - sim.t0) / 1000 * 1500 * 1.4);
    var X = function (t) { return t / 1500 * W; }, Y = function (v) { return Hh * 0.88 - v * Hh * 0.74; };
    function curve(col, width, dash, f) {
      g.strokeStyle = col; g.lineWidth = width * d; g.setLineDash(dash.map(function (x) { return x * d; }));
      g.beginPath(); for (var t = 0; t <= shown; t += 2) { var v = f(t); if (t === 0) g.moveTo(X(t), Y(v)); else g.lineTo(X(t), Y(v)); } g.stroke(); g.setLineDash([]);
    }
    curve(css('--muted'), 1.5, [5, 4], sim.e);
    curve(css('--flame'), 3, [], function (t) { var v = 0; for (var i = 0; i < sim.arrivals.length && sim.arrivals[i][0] <= t; i++) v = sim.arrivals[i][1]; return v; });
    curve(css('--teal'), 3, [], function (t) { return sim.e(t - (sim.rampAt - 100)); });
  }
  $('jit').addEventListener('input', function () { $('jit-o').textContent = Math.round($('jit').value * 2) + ' ms'; });
  $('jit-o').textContent = Math.round($('jit').value * 2) + ' ms';
  $('fire').addEventListener('click', fire);

  // ---------------------------------------------------------------- one animation loop for all three drawings
  var tPrev = performance.now(), visible = { blot: true, pend: true, sim: true };
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { visible[e.target.id] = e.isIntersecting; }); });
    ['blot', 'pend', 'sim'].forEach(function (id) { io.observe($(id)); });
  }
  (function frame(now) {
    var dt = Math.min(0.1, (now - tPrev) / 1000); tPrev = now;
    var t = now / 1000;
    if (visible.blot) drawBlot(reduce ? 0 : t, reduce ? 0 : dt);
    else { spinA += (B.spin - 0.1) * dt * 1.6; splat *= Math.pow(0.12, dt); breath = 0.5 + 0.5 * Math.sin(t * 1.1); }   // keep living off screen
    if (visible.pend) drawPend(t, reduce ? dt * 0.3 : dt); else stepPend(dt);
    if (visible.sim) drawSim(now);
    requestAnimationFrame(frame);
  })(tPrev);

  // ---------------------------------------------------------------- is the relay open this month?
  fetch('https://invisible-hands.samuelling.workers.dev/status').then(function (r) { return r.json(); }).then(function (s) {
    $('relay-open').textContent = s.open ? 'Right now: open.' : 'Right now: closed until the 1st.';
  }).catch(function () {});
  status();
})();
