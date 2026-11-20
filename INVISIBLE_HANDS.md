# Invisible Hands: instructions for Claude

> **For the person reading this:** put this file in your project and tell your Claude:
> *"Read INVISIBLE_HANDS.md and add Invisible Hands to this app."*
> It will ask you what should be movable if it can't tell, then wire it up and give you a link to test with.
> Website: https://samuelling.github.io/InvisibleHands/ · Source: https://github.com/samuelling/InvisibleHands

---

Claude, this file tells you how to add **Invisible Hands** to the app in front of you. Follow it as written. It is protocol 1; don't invent messages or fields.

## What it is

Invisible Hands lets one app move another app's controls over the internet, and hear that app's outputs back. Think of a modular synth patch cable with a phone line in the middle. Apps meet in a **room** (a code like `moss-kiln-opal-fern-42`) on a small public relay at `wss://invisible-hands.samuelling.workers.dev`. Each app announces its controls; anyone else in the room can **set** them, **mod** them (swing them around where the owner left them, like an LFO), or **ramp** them (an envelope the receiving app plays on its own clock). Apps can also publish **outputs** that others use as modulation sources. Only numbers and short labels travel. Every value is 0 to 1.

Three roles. Work out which the app needs:

- **Destination** (be moved): the app has things worth turning. Most apps.
- **Source** (move others): the app makes modulation: LFOs, envelopes, sequencers, sensors, a mod matrix.
- **Both**: a destination that also publishes outputs, or a source that is also movable.

## Step 1. Choose what to expose

If the person told you which controls, use those. Otherwise read the app and propose a list, then ask once. Good candidates:

- continuous parameters a person could enjoy turning: speed, size, colour, density, filter cutoff, reverb, camera distance, spread, chaos
- **random parameters and seeds** (these are some of the most fun to hand to someone else)
- toggles (on/off) and triggers (a button that fires: a burst, a new shape, a drum hit)

Leave out: anything destructive or hard to undo (delete, reset all, clear, save, navigate away, purchase), anything that reveals or sends personal data, account settings, and file pickers. Cap anything that could hurt: master volume above a safe level, strobe or flash rates (keep rapid full-screen flashing below 3 per second), camera or microphone switches (never expose those).

Aim for 4 to 20 controls. The protocol allows up to 128 per app; nobody can patch 128.

Each control needs:

- `id`: short, stable, camelCase or kebab-case, e.g. `spatialFreq`. **Never rename an id once shipped**: other people's patches and invite links refer to it.
- `label`: what a person reads, e.g. `Spatial frequency`. Plain text, at most 64 characters.
- `kind`: `cont` (default), `toggle` (off below 0.5, on above), or `trig` (fires when it crosses 0.5 going up).

## Step 2. Map every control to 0..1

The protocol only carries 0..1. Write the mapping into `get` and `set`, and make them exact inverses so `describe` reports the true position.

```js
// linear:      lo..hi
const lin  = (v, lo, hi) => lo + v * (hi - lo),            unlin  = (x, lo, hi) => (x - lo) / (hi - lo);
// logarithmic: frequencies, times, sizes that span decades (lo > 0)
const expo = (v, lo, hi) => lo * Math.pow(hi / lo, v),     unexpo = (x, lo, hi) => Math.log(x / lo) / Math.log(hi / lo);
// a choice among n options (a menu, a mode, a preset)
const pick = (v, n) => Math.min(n - 1, Math.floor(v * n)), unpick = (i, n) => (i + 0.5) / n;
// an integer count lo..hi
const count = (v, lo, hi) => Math.round(lin(v, lo, hi));
```

Clamp before mapping. Use logarithmic mapping for anything a person hears or sees in ratios (Hz, seconds, zoom).

## Step 3. Add it (web apps)

Load the one file. Prefer a vendored copy so the app keeps working if a URL moves: download `https://samuelling.github.io/InvisibleHands/invisible-hands.js` into the project next to the app's other scripts. Linking it directly also works:

```html
<script src="https://samuelling.github.io/InvisibleHands/invisible-hands.js"></script>
```

In an ES-module app, import it for its side effect: `import './invisible-hands.js';` then use `globalThis.InvisibleHands`. It has no dependencies and also runs under Node 22+ (which has a global `WebSocket`).

Create it **once**, after the app's state exists:

```js
const hands = InvisibleHands.create({
  app: 'my-app',                 // slug for the kind of app: a-z 0-9 . _ - ; same for every copy of this app
  name: 'My App',                // what people see
  params: [
    { id: 'speed', label: 'Speed', get: () => unexpo(state.speed, 0.1, 10), set: v => { state.speed = expo(v, 0.1, 10); } },
    { id: 'hue',   label: 'Hue',   get: () => state.hue, set: v => { state.hue = v; } },
    { id: 'burst', label: 'Burst', kind: 'trig', get: () => 0, set: v => { if (v > 0.5) fireBurst(); } },
    { id: 'trails',label: 'Trails',kind: 'toggle', get: () => state.trails ? 1 : 0, set: v => { state.trails = v > 0.5; } }
  ],
  outs: [                        // optional: values others can use as sources, 0..1
    { id: 'level', label: 'Level', get: () => meter.level }
  ]
});
```

That is a complete destination. Details that matter:

- `set` is called from timers and network callbacks, many times a second. Keep it cheap: write the value and let the app's own render or audio loop pick it up. Don't rebuild scenes or re-layout the page in `set`.
- If the app has its own UI control for the same value (a slider), update it in `set` too so the screen tells the truth. When the person moves that slider by hand, call `hands.recenter('speed')` in its input handler: a running modulation then swings around the new position instead of snapping back to the old one.
- A `trig` control: `set` sees values cross 0.5; fire on the rising edge only. `get` returns 0.
- Audio: don't jump an `AudioParam`. Use `param.setTargetAtTime(target, ctx.currentTime, 0.015)` in `set` to avoid clicks.
- Optional `mod(v)` on a param (v is -1..1) if the app wants to handle modulation itself, e.g. modulating a frequency in octaves instead of in 0..1 space.
- If the set of controls changes while running, change the array you passed and call `hands.describe()`.

### The panel and the rules

Every movable app must (1) show when it is linked, (2) give the person a way to stop remote control, (3) keep local hands in charge. The built-in panel does all three:

```js
settingsBox.append(hands.panel());   // Start a room · Join · Copy invite link · Leave · "Let others move my controls"
```

**Pin the mark** on every control you exposed, right after its label, so people know why it might move by itself:

```js
speedLabel.append(hands.tag('speed'));   // the Invisible Hands mark: grey unlinked, lit when linked, jumps on remote moves
toolbar.append(hands.badge());           // optional: a button with the mark that opens the panel
```

Only controls that are actually offered get a tag. `InvisibleHands.icon({ size: 24 })` draws the mark alone if the app needs it somewhere else. The look is described at https://samuelling.github.io/InvisibleHands/brand/.

`panel()` returns a plain element that takes the host page's font and colour. Once in a room it also offers **Bring in MEGA·CV**, which opens that modular synth in the same room for richer modulation; leave it on unless the person says otherwise (`create({ megacv: false })` hides it). Put it where the app keeps its settings or behind a small button (a hand icon, or the word "Hands"). Don't put it over the main view by default. If you build your own UI instead, use `hands.status`, `hands.room`, `hands.peers`, `hands.inviteUrl()`, `hands.join(code)`, `hands.newRoom()`, `hands.leave()`, and the `hands.allow` switch.

A page opened with `?room=<code>` joins that room by itself, so an invite link is just the app's address plus `?room=`.

Never insert another app's `name`, `label` or `id` into the page as HTML. Use `textContent`. The relay strips control characters and cuts text to 64 characters, but treat everything from other peers as untrusted text.

## Step 4. Sending (sources)

First check the person needs one. Wiring two apps directly is what the console's patch matrix does (https://samuelling.github.io/InvisibleHands/console/), and MEGA·CV (https://crumplabsandbox.github.io/mega-cv/) is the best general modulator for Invisible Hands. Write a source only when the app itself should do the turning.

```js
const hands = InvisibleHands.create({ app: 'my-lfo', name: 'My LFO' });   // params can be empty
hands.join(code);                                                          // or let ?room= join it
hands.on('peers', peers => { /* each peer: {id, app, name, params:[{id,label,kind,value}], outs:[{id,label}], state:{} } */ });

hands.set(to, 'speed', 0.7);                    // put it at 0.7
hands.mod(to, 'speed', 0.25 * Math.sin(ph));    // swing ±0.25 around where its owner left it; send 0 to let go
hands.ramp(to, 'burst', [[5, 1], [300, 0]], hands.serverNow() + 80);   // an envelope, played on the far side
hands.on('state', peer => { /* peer.state.level, 0..1: use as a modulation source */ });
```

`to` is a peer object or peer id (one connection), `'app:<slug>'` (every copy of that app in the room), or `null` (everyone else). Prefer `'app:<slug>'` in saved patches: peer ids change every time someone reconnects.

Timing rules:

- **Every frame costs the relay money, whatever its size** (it is free to use; the megaZINE editors pay for it). The library already skips repeated values, packs moves made in the same moment into one frame, and pings rarely. Your part: make all of one tick's moves in the same callback (one timer for all LFOs, not one timer each), so they leave together.
- Continuous movement (LFOs, a hand on a slider): send `mod` or `set` at **at most 20 to 25 per second per control**, and only when the value changed by more than about 0.003. Slow LFOs (under 1 Hz) look the same at 10 per second. The relay allows 120 messages a second per connection with a burst of 240, and closes connections that keep flooding.
- Sharp shapes (envelopes, gates, drum hits): send **one `ramp`**, not a stream of sets. Give it `at: hands.serverNow() + 80` so every copy of the destination starts together.
- Browsers throttle timers in hidden tabs to once a second. If the source must keep sending while in the background, drive the send loop from a Web Worker timer (`new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),40)'])))`), not `requestAnimationFrame`.
- When you stop modulating a control, send `mod` with `0` (or a final `set`) so it doesn't stay where you happened to leave it. When a new peer joins, re-send current values: it has never heard them. Don't add "keep-alive" re-sends of unchanged values.
- If `hands.status` becomes `'error'`, the relay refused for a reason retrying won't fix (the relay's monthly allowance is used up, or a key it doesn't know). Show `hands.error` to the person; don't loop.

## Step 5. Not a web page?

- **Python** (desktop tools, TouchDesigner, Blender, a Raspberry Pi, a data feed): use `invisible_hands.py` from the kit (`pip install websockets`). Same API: `hands.param(...)`, `hands.out(...)`, `hands.start(code)`, `hands.set/mod/ramp(...)`. Use `start(code, poll=True)` and call `hands.poll()` every frame when the host app is single-threaded (Blender, TouchDesigner, pygame), so `set` runs on the host's thread.
- **Max, Pd, Ableton Live, SuperCollider, TouchDesigner via OSC**: run `python invisible_hands.py osc <room> --param cutoff --param warp`. OSC `/hands/set/<to>/<param> v`, `/hands/mod/<to>/<param> v` go into the room; remote moves of `--param` controls arrive as `/hands/param/<id> v`, and other apps' outputs as `/hands/state/<app>/<out> v`.
- **Node**: `invisible-hands.js` works as-is in Node 22+ (load it, then `globalThis.InvisibleHands`); skip `panel()`.
- **Anything else** (Swift, Kotlin, C++, Go, Rust, Lua): it is JSON over one WebSocket. Read `SPEC.md` and `GUIDE.md` in the kit and write a small client: connect, answer `welcome` with `describe`, re-`describe` to each `join`, apply `set`/`mod`/`ramp` with clamping, publish `state` at most 15 times a second and only when outputs change, and don't retry after close codes 4001, 4003, 4008 or 4029. `GUIDE.md` has a full wire transcript and short clients to copy from.

## Step 6. Test it, then tell the person

1. Run the app. Open the panel and press **Start a room** (or open the app with `?room=test-<anything>`). To test offline, run the relay locally (`cd relay && npm install && npm run dev`) and open the app with `?relay=ws://localhost:8787`.
2. Open the **console** in another tab or on a phone with the same room: `https://samuelling.github.io/InvisibleHands/console/?room=<code>`. The app's controls appear there; drag one, press LFO, press Env. Its outputs show as meters.
3. Check: every exposed control moves the app, the app's own UI follows, and its tag jumps; the panel shows Linked; unticking "Let others move my controls" stops remote moves at once; outputs meter in the console; nothing breaks when the console leaves or the network drops (the library reconnects by itself).
4. If you can't open a browser yourself, say so and give the person these steps.

Finish by telling the person: which controls you exposed (id, label, range mapping), what outputs the app publishes, where the panel (or badge) is, and a ready-made test link: the app's address with `?room=<code>`, plus the console link with the same room.

## Don'ts

- Don't change the protocol or add fields; unknown fields are dropped by the relay anyway.
- Don't run your own relay unless asked. If asked, the relay code is in the kit (`relay/`, Cloudflare Workers); then pass `relay: 'wss://…'` to `create()`.
- Don't expose a control that executes code, loads a URL, or reads files.
- Don't send faster than the timing rules say, and don't send from inside a `set` callback (that's how loops start).
- Don't store room codes anywhere public: anyone who has one can join that room.

## The limits (enforced by the relay)

16 connections per room · 32 KB per message · 128 controls and 64 outputs per app · 32 points per ramp, each up to 10 minutes · text 64 characters · 240-message burst, refilling at 120 per second, per connection · 30 new connections a minute per IP address · a monthly allowance for the whole relay: if it runs out, the relay closes until the 1st.
