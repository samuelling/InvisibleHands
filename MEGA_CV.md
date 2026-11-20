# MEGA·CV on a lighter footprint: notes for Matt's Claude

You're working in `crumplabsandbox/mega-cv` with Matt. These notes are about its Invisible Hands module (`js/net/hands.js`) and what it costs the relay. The relay runs on Sam's Cloudflare account. These changes cut what MEGA·CV sends by about two thirds while it plays, and to nothing while it's alone in a room. The module works the same as before.

Matt decides whether these changes go in. Show him this page and the diff before you commit anything.

## Why it matters

The relay counts every frame that comes **in**: 20 incoming frames bill as one Cloudflare request. Frames going out to the other apps are free. The plan includes 1 million requests a month. Once the relay has taken 18 million frames in a month, it closes to everyone until the 1st, so one busy MEGA·CV left running uses up everyone's month.

Measured with the "Hands: Chamber LFO Lab" preset (three LFOs and a clock gate) against a local relay:

| | Now | After |
| --- | --- | --- |
| Four slots moving, another app in the room | 56 frames/s | 20 frames/s |
| Same patch, nobody else in the room | 57 frames/s | 0 |
| Nothing moving, another app in the room | 0.9 frames/s | 0.07 frames/s |
| One hour of the busy patch | ~10,000 billed requests | ~3,600 |
| Hours of it that close the relay for the month | ~90 | ~250 |

The other app received the patch just as smoothly in both runs: 20 moves a second per slot instead of 25. SPEC.md recommends 20 to 30 a second for slow movement.

## What wastes frames now

1. **The vendored library is the old one.** `js/net/invisible-hands.js` pings the relay every 10 seconds for as long as you're in a room, even when nothing moves. It also sends every message as its own frame. The current library pings three times on joining, then once every 5 minutes. It also packs the moves made in the same moment into one `batch` frame. MEGA·CV's `pump()` sends every slot in one synchronous loop, so all four slots leave as one frame.
2. **It sends to an empty room.** With nobody else in the room, every frame is billed and nobody receives it.
3. **The keep-alive runs every 5 seconds, for each slot separately.** It exists so Chamber sites don't hand control back to their own LFOs. Chamber waits 20 seconds after the last remote move before it does that (`engine/bridge.js`, `lastRemote`). So every 15 seconds is enough, and all slots can re-send in the same tick, as one frame.
4. **It resends everything on every `peers` event.** That event also fires when a peer re-describes its controls. A resend is needed only when someone new arrives or the link comes back.

## The changes

### 1. Swap in the current library

```sh
curl -o js/net/invisible-hands.js https://samuelling.github.io/InvisibleHands/invisible-hands.js
```

Keep it unchanged, as now. Nothing in `hands.js` has to change for the swap: `create`, `join`, `leave`, `newRoom`, `inviteUrl`, `set`, `mod`, `peers`, `room`, `status` and `error` all behave as before. Two differences:

- `set` and `mod` now return `true` without sending when they get the same value for the same control within 4 seconds. The module's budget treats that as a send, which is harmless.
- The library's panel has a "Bring in MEGA·CV" link. It stays hidden when `app` is `'mega-cv'`, so it never shows in MEGA·CV.

Batching only happens when the relay's `welcome` says `batch: true`. The new relay does; the old one doesn't. The library checks for this itself and sends single frames otherwise, so nothing breaks while the relay is still the old one.

### 2. Patch `js/net/hands.js`

This is the whole diff, tested against the current `main` (438a5e2):

```diff
@@ -14,5 +14,5 @@ const RELAY = 'wss://invisible-hands.samuelling.workers.dev'; // given explicitl
 const SLOTS = 4;
-const SEND_MS = 40;         // 25 Hz per slot
+const SEND_MS = 50;         // 20 Hz per slot; every slot that moves in one tick leaves in a single frame
 const BUDGET = 90;          // messages per second for all copies together; the relay allows 120 per connection
-const KEEPALIVE = 5000;     // re-send an unchanged value this often, so sites don't drift back to their own LFOs
+const KEEPALIVE = 15000;    // re-send held values this often, all in one tick, so sites don't drift back to their own LFOs (Chamber waits 20 s)
 const MODES = ['Mod ±1', 'Set 0..1', 'Set ±1→0..1', 'Gate'];
@@ -20,3 +20,3 @@ const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
 
-let hands = null, timerOn = false, tokens = BUDGET, tLast = 0, rr = 0;
+let hands = null, timerOn = false, tokens = BUDGET, tLast = 0, rr = 0, keepAt = 0, seen = '';
 const insts = new Set();
@@ -26,4 +26,11 @@ function link() {
   hands = globalThis.InvisibleHands.create({ app: 'mega-cv', name: 'MEGA·CV', relay: RELAY }); // joins ?room=… by itself
-  const changed = () => insts.forEach(i => { i.impl.resend(); i.impl.redraw?.(); });
-  hands.on('status', changed); hands.on('peers', changed);
+  // say every value again only when someone new arrives or the link comes back, not on every describe
+  const redraw = () => insts.forEach(i => i.impl.redraw?.());
+  const again = () => insts.forEach(i => i.impl.resend());
+  hands.on('status', st => { if (st === 'on') { seen = ''; again(); } redraw(); });
+  hands.on('peers', list => {
+    const ids = list.map(q => q.id).sort().join(' ');
+    if (ids.split(' ').some(x => x && !(' ' + seen + ' ').includes(' ' + x + ' '))) again();
+    seen = ids; redraw();
+  });
   return hands;
@@ -46,3 +53,4 @@ function pump() {
   for (const inst of list) inst.impl.recv();
-  if (h.status !== 'on') return;
+  if (h.status !== 'on' || !h.peers.length) return; // alone in the room: nobody to move, so nothing is sent
+  const keep = now >= keepAt; if (keep) keepAt = now + KEEPALIVE;
   const n = list.length * SLOTS;
@@ -51,3 +59,3 @@ function pump() {
     if (tokens < 1) { rr = j; return; } // out of budget: the next round starts with the slot that missed out
-    if (list[Math.floor(j / SLOTS)].impl.send(j % SLOTS, now)) tokens--;
+    if (list[Math.floor(j / SLOTS)].impl.send(j % SLOTS, keep)) tokens--;
   }
@@ -77,3 +85,3 @@ register({
     const ains = {}, aouts = {}, an = [], cs = [], buf = new Float32Array(32);
-    const live = Array(SLOTS).fill(0), cur = Array(SLOTS).fill(null), sentAt = Array(SLOTS).fill(0);
+    const live = Array(SLOTS).fill(0), cur = Array(SLOTS).fill(null), said = Array(SLOTS).fill(false);
     for (let i = 0; i < SLOTS; i++) {
@@ -111,3 +119,3 @@ register({
       connected(inp, d) { const i = +inp.slice(2) - 1; live[i] = Math.max(0, live[i] + d); },
-      resend() { sentAt.fill(0); }, // someone joined or the link came back: say every value again
+      resend() { said.fill(false); }, // someone joined or the link came back: say every value again
       // received: published outputs of the chosen app become CV
@@ -121,4 +129,4 @@ register({
       },
-      // send slot i if its value moved, or to keep it alive; returns true when a message went out
-      send(i, now) {
+      // send slot i if its value moved, or on the shared keep-alive tick; returns true when a message went out
+      send(i, keep) {
         const d = parseDest(inst.params['d' + (i + 1)]);
@@ -133,5 +141,5 @@ register({
         const moved = !same || Math.abs(v - c.v) >= (mode === 3 ? 0.5 : 0.004);
-        if (!moved && now - sentAt[i] < KEEPALIVE) return false;
+        if (!moved && !keep && said[i]) return false;
         if (!(mode === 0 ? h.mod(d.to, d.p, v) : h.set(d.to, d.p, v))) return false;
-        cur[i] = { to: d.to, p: d.p, mode, v }; sentAt[i] = now;
+        cur[i] = { to: d.to, p: d.p, mode, v }; said[i] = true;
         return true;
```

What stays the same: the worker timer, so sends keep their pace in a background tab; the shared budget; the range checks; letting go of a re-aimed slot; the fixed relay address; and not rejoining a saved room until asked.

### 3. Leave out

- New timers, heartbeats or "still here" messages. The relay never needs one, and every one is billed.
- A rate above 20 a second per slot. For sharp shapes (envelopes, triggers), one `ramp` message is better than many `set`s: `hands.ramp(to, p, [[ms, v], …], hands.serverNow() + 80)`. The destination plays the ramp on its own clock.
- Pings of your own. The library handles the clock.

## Check it

Open MEGA·CV, load a Hands preset, join a room, and open a second app in the same room (any Chamber site, or https://samuelling.github.io/InvisibleHands/console/). Then paste this into the browser console:

```js
let n = 0; const s = WebSocket.prototype.send;
WebSocket.prototype.send = function (d) { n++; return s.call(this, d); };
setInterval(() => { console.log(n, 'frames/s'); n = 0; }, 1000);
```

You should see:

- **20 or fewer frames a second** while slots move. This needs the new relay; on the old one it's up to one frame per slot per tick.
- **0** once the other app leaves the room.
- **About one frame every 15 seconds** while nothing moves.
- **Chamber sites still held:** their own LFOs don't take over while MEGA·CV is patched and still.

The console's Peers list shows what arrives at the other end.

To test against a local relay instead of the live one, clone https://github.com/samuelling/InvisibleHands, run `cd relay && npm install && node dev-server.mjs`, and point `RELAY` in `hands.js` at `ws://localhost:8787` while testing. Put it back before committing.

## More

- The protocol, limits and "Saving frames": https://samuelling.github.io/InvisibleHands/SPEC.md
- The library guide for Claude: https://samuelling.github.io/InvisibleHands/INVISIBLE_HANDS.md
- Questions for Sam: the megaZINE `HANDOFF.md`, or the BBS.
