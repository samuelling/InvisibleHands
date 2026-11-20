/* Bits every page shares: the gold seal, the copier jitter on the logo, copy buttons. */
(function () {
  'use strict';
  // ---- the megaZINE seal: who made it, and how ----
  var BURST = (function () {
    var pts = [], n = 36;
    for (var i = 0; i < n * 2; i++) { var r = i % 2 ? 45 : 49.5, a = (Math.PI * i) / n - Math.PI / 2; pts.push((r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2)); }
    return pts.join(' ');
  })();
  function names(list) {
    var lines = list.map(function (n, k) { return { amp: k > 0, text: n.toUpperCase() }; });
    var R = 26.5, label = 5.6, gap = 2.2, wide = function (l) { return (l.text.length + (l.amp ? 1.25 : 0)) * 0.72; };
    for (var fs = 19; fs >= 3; fs -= 0.25) {
      var pitch = fs * 0.98, block = label + gap + (lines.length - 1) * pitch + fs * 0.72, top = -block / 2 - 0.6;
      var base = lines.map(function (l, k) { return top + label + gap + k * pitch + fs * 0.72; });
      var fits = lines.every(function (l, k) { var y = Math.max(Math.abs(base[k]), Math.abs(base[k] - fs * 0.72)); return y < R && wide(l) * fs / 2 <= Math.sqrt(R * R - y * y); });
      if (fits) return { fs: fs, labelY: top + label * 0.8, lines: lines.map(function (l, k) { return { amp: l.amp, text: l.text, y: base[k] }; }) };
    }
    return { fs: 3, labelY: -4.5, lines: [{ text: list.join(' & ').toUpperCase(), y: 3 }] };
  }
  function seal(makers, how) {
    var f = names(makers);
    var nm = f.lines.map(function (l) { return '<text class="name" y="' + l.y.toFixed(1) + '" font-size="' + f.fs.toFixed(2) + '" text-anchor="middle">' + (l.amp ? '<tspan font-size="' + (f.fs * 0.62).toFixed(2) + '">&amp; </tspan>' : '') + l.text + '</text>'; }).join('');
    return '<svg class="seal" viewBox="-50 -50 100 100" role="img" aria-label="megaZINE seal: made by ' + makers.join(' and ') + ', ' + how.toLowerCase() + '">' +
      '<defs><radialGradient id="seal-g" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="var(--gold-hi)"/><stop offset=".55" stop-color="var(--gold)"/><stop offset="1" stop-color="var(--gold-lo)"/></radialGradient>' +
      '<path id="seal-t" d="M -33 0 A 33 33 0 0 1 33 0"/><path id="seal-b" d="M -39.5 0 A 39.5 39.5 0 0 0 39.5 0"/></defs>' +
      '<polygon points="' + BURST + '" fill="url(#seal-g)" stroke="var(--gold-lo)" stroke-width=".8"/>' +
      '<circle r="42.5" fill="none" stroke="var(--gold-ink)" stroke-width="1" opacity=".55"/><circle r="29" fill="none" stroke="var(--gold-ink)" stroke-width="1.1" opacity=".7"/>' +
      '<text font-size="7.6" letter-spacing="1.1"><textPath href="#seal-t" startOffset="50%" text-anchor="middle">MEGAZINE SEAL</textPath></text>' +
      '<text font-size="6.4" letter-spacing=".6"><textPath href="#seal-b" startOffset="50%" text-anchor="middle">' + how + '</textPath></text>' +
      '<text x="-37" y="2.6" font-size="7" text-anchor="middle">★</text><text x="37" y="2.6" font-size="7" text-anchor="middle">★</text>' +
      '<text class="name" y="' + f.labelY.toFixed(1) + '" font-size="5.6" text-anchor="middle" letter-spacing=".8">MADE BY</text>' + nm + '</svg>';
  }
  var slot = document.getElementById('seal-slot');
  if (slot) slot.outerHTML = seal(['Sam', 'Matt'], 'HANDS + CLAUDE');

  // ---- the logo slips in the copier now and then ----
  var logo = document.getElementById('logo');
  if (logo && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    (function hop() {
      setTimeout(function () { logo.classList.remove('jit'); void logo.offsetWidth; logo.classList.add('jit'); hop(); }, 3500 + Math.random() * 5500);
    })();
    logo.addEventListener('animationend', function (e) { if (e.target.classList.contains('mis')) logo.classList.remove('jit'); });
  }

  // ---- copy buttons: <button class="copy" data-copy="element-id"> ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button.copy');
    if (!b) return;
    var el = document.getElementById(b.getAttribute('data-copy'));
    if (!el) return;
    var text = el.textContent, done = function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  });
})();
