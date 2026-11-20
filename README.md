# Invisible Hands

Move one app's controls from another app, anywhere on the internet.

An app that includes Invisible Hands lists its controls. Anyone in the same **room** can set them, swing them with an LFO, or fire an envelope at them, and can hear the app's own outputs coming back. It is control voltage with a phone line in the middle.

**Website, kit and console: https://samuelling.github.io/InvisibleHands/** (GitHub Pages, from `main`). In the December 2026 megaZINE.

- `invisible-hands.js`: the one file a web app adds. No dependencies. Also runs in Node 22+.
- `INVISIBLE_HANDS.md`: instructions for Claude. Drop it in a project and say "Read INVISIBLE_HANDS.md and add Invisible Hands to this app."
- `GUIDE.md`: doing it yourself, in any language: a wire transcript, step-by-step, a Swift sketch.
- `SPEC.md`: the protocol, one page.
- `python/`: a Python client with a command line (peers, set, lfo, listen) and an OSC bridge for Max, Pd, Live, TouchDesigner.
- `examples/`: the smallest web app that can be moved, a no-library JavaScript destination, and a Go one.
- `brand/`: the mark (knob, fingertips, teal and flame) as SVGs, and a page on using it. In the library: `hands.tag(id)` beside a control, `hands.badge()` in a toolbar, `InvisibleHands.icon()`.
- `index.html`, `docs/`, `site/`: the website (concept, four live demos, step-by-step docs). `keys/`: the editors' page for optional keys and this month's usage.
- `console/`: the **console**, with MEGA·CV always on offer (one button opens it in the same room). Join a room and move whatever is in it, or patch any app's output into any app's knob with its patch matrix (saved in the address). Also the reference for anything that sends.
- `invisible-hands-kit.zip`: everything above in one download (`python3 tools/make_kit.py` rebuilds it).
- `relay/`: the room relay, for Cloudflare, with a local version for development.

## Add it to an app

```html
<script src="invisible-hands.js"></script>
<script>
const hands = InvisibleHands.create({
  app: 'my-app', name: 'My App',
  params: [
    { id: 'speed', label: 'Speed', get: () => speed, set: v => { speed = v; } }   // v is always 0..1
  ],
  outs: [
    { id: 'beat', label: 'Beat', get: () => beat }                                // optional
  ]
});
someButton.onclick = () => someDialog.append(hands.panel());                     // optional built-in panel
</script>
```

That is all. A page opened with `?room=<code>` joins by itself; otherwise the panel has **Start a room**, a box to type a code, and **Copy invite link**.

Each control needs `id`, `get` and `set`. Optional: `label`, `kind` (`cont`, `toggle`, `trig`), and `mod(v)` if the app wants to handle modulation itself (otherwise Invisible Hands swings the control around the value it had).

Random parameters work the same way: list them, and someone else can set them.

### What the app gets back

```js
hands.status            // 'off' | 'connecting' | 'on' | 'retrying' | 'error'
hands.peers             // [{id, app, name, params, outs, state}]
hands.allow = false     // stop others moving this app's controls
hands.on('peers' | 'state' | 'status' | 'in' | 'error', fn)
hands.set(to, id, v)    hands.mod(to, id, v)    hands.ramp(to, id, [[ms, v], …], at)
hands.join(code)        hands.leave()           hands.newRoom()        hands.inviteUrl()
hands.recenter(id)      // the person moved a control by hand: modulation swings around the new spot
```

## Try it locally

```
cd relay
npm install
npm run dev                      # relay on ws://localhost:8787
```

Serve this folder (`python3 -m http.server 8000`), then open, with the same room in both:

- `http://localhost:8000/examples/minimal.html?room=test-room&relay=ws://localhost:8787`
- `http://localhost:8000/console/?room=test-room&relay=ws://localhost:8787`

Drag a slider in the console and the dot in the other page changes.

## Put the relay on Cloudflare

```
cd relay
npx wrangler login
npx wrangler secret put ADMIN_TOKEN      # once: a long passphrase for the editors' keys page
npx wrangler deploy
```

The deployed relay is `wss://invisible-hands.samuelling.workers.dev`, already set as `DEFAULT_RELAY` in both clients; `?relay=wss://…` or `relay:` in `create()` override it. `wrangler.toml` holds the KV namespace for keys (`invisible-hands-keys`), the rate limits and the ceilings.

The relay keeps a guest list for each room and a monthly count, and nothing else. It checks every message against the limits in `SPEC.md`, stamps it with its sender, and passes it on. It stores no values.

## Keys and costs

The relay runs on Sam's Cloudflare account (Workers Paid). What it costs is **incoming frames**: 20 bill as one Durable Objects request, 1,000,000 requests a month are included (about 20 million frames), then $0.15 per million requests. Rooms hibernate when quiet, so idle connections cost next to nothing; outgoing messages are free.

- **Open.** Anyone can connect, with no key. Usage is counted per website (and `@program` for anything without one), so the editors can see who is busy on `/keys/`.
- **Optional keys.** The editors can issue a key on `/keys/` to give one app its own ceiling, or an *editor* key that keeps working past the relay's ceiling. A key works only from the websites it names (or from programs, if *native*).
- **Ceilings.** Busy rooms report their frame counts to one meter once a minute (quiet rooms report nothing). Past `MONTHLY_FRAMES` (18M, inside the included allowance), new connections are refused and open ones closed until the 1st, except *editor* keys. So the bill should stay inside what the $5 plan includes.
- **Floods.** 30 new connections a minute per IP; 240 messages at once per connection, refilling at 120 a second; a connection that keeps flooding is closed. Refusals are answered in the Worker, without waking a room.
- **Less to send.** Both clients send a value only when it changes, pack moves made together into one batch frame, publish outputs only when they move, and ping every 5 minutes instead of every 10 seconds.

## Tests

```
cd relay
npm test                               # the message rules, against the local relay
node test.mjs ws://localhost:8787      # the same checks against any running relay (it uses a house origin)
node test-worker.mjs                   # optional keys, ceilings and floods, against the real worker under wrangler dev
cd ../python
python3 test_invisible_hands.py        # the Python client, including the JS library moving it
```

## What is and is not here yet

- Built and tested: the relay (locally, both the Node version and the real Cloudflare worker under `wrangler dev`), the drop-in file, the console, the example.
- Deployed: the relay runs at `wss://invisible-hands.samuelling.workers.dev` (19 Nov 2026). The Chamber sites and MEGA·CV use it.
- Built and tested, not yet deployed (20 Nov 2026): the meter and monthly ceiling, optional keys, per-IP limits, flood cut-off and batch frames (`node test-worker.mjs`, 21 checks under `wrangler dev`). Needs `wrangler secret put ADMIN_TOKEN` and `wrangler deploy`.
- Built and tested (20 Nov 2026): the Python client and its OSC bridge, the no-library JavaScript and Go examples, all against the local relay; the Python command line against the deployed one.
- Not built: a Swift version for iPhone apps. `GUIDE.md` has an uncompiled sketch.
