# Invisible Hands

Move one app's controls from another app, anywhere on the internet.

An app that includes Invisible Hands lists its controls. Anyone in the same **room** can set them, swing them with an LFO, or fire an envelope at them, and can hear the app's own outputs coming back. It is control voltage with a phone line in the middle.

- `invisible-hands.js`: the one file an app adds. No dependencies.
- `index.html`: the **console**. Join a room and move whatever is in it. Also the reference for anything that sends.
- `SPEC.md`: the protocol, one page.
- `relay/`: the room relay, for Cloudflare, with a local version for development.
- `examples/minimal.html`: the smallest app that can be moved.

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
```

## Try it locally

```
cd relay
npm install
npm run dev                      # relay on ws://localhost:8787
```

Serve this folder (`python3 -m http.server 8000`), then open, with the same room in both:

- `http://localhost:8000/examples/minimal.html?room=test-room&relay=ws://localhost:8787`
- `http://localhost:8000/index.html?room=test-room&relay=ws://localhost:8787`

Drag a slider in the console and the dot in the other page changes.

## Put the relay on Cloudflare

```
cd relay
npx wrangler login
npx wrangler deploy
```

Wrangler prints an address like `https://invisible-hands.<you>.workers.dev`. Put it, as `wss://…`, in `DEFAULT_RELAY` near the top of `invisible-hands.js`. Until then an app needs `?relay=wss://…` in its address, or `relay:` in `create()`.

The relay keeps a guest list for each room and nothing else. It checks every message against the limits in `SPEC.md`, stamps it with its sender, and passes it on. It stores no values.

## Tests

```
cd relay
npm test                               # 26 checks against the local relay
node test.mjs ws://localhost:8787      # the same checks against any running relay
```

## What is and is not here yet

- Built and tested: the relay (locally, both the Node version and the real Cloudflare worker under `wrangler dev`), the drop-in file, the console, the example.
- Not done: the relay has not been deployed, so there is no built-in relay address yet.
- Not built: a Swift version for iPhone apps. The protocol is plain JSON over a WebSocket, so it is a small file when wanted.
