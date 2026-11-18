# Invisible Hands: protocol 1

A way for one app to move another app's controls over the internet, and to hear that app's outputs back. Apps meet in a **room** on a small relay. Only numbers and short labels travel.

Think of control voltage with a phone line in the middle: every value is 0 to 1, any app can be a source, a destination, or both.

## Connecting

Open a WebSocket to the relay:

```
wss://<relay>/room/<code>?app=<slug>&name=<display name>
```

- `code`: 4 to 48 characters, `a-z 0-9 -`. Whoever starts the room invents it; everyone else is given it.
- `app`: a short slug for the kind of app (`gaborgrove`, `mega-cv`). `name`: what people see.
- Up to 16 connections per room. Messages are JSON text, one object per frame, at most 32 KB.

The relay answers at once:

```json
{"t":"welcome","v":1,"id":"k3x9qa","now":1795000000000,"peers":[{"id":"p7m2zd","app":"gaborgrove","name":"Gabor Grove"}]}
```

`id` is yours for this connection. `now` is the relay's clock in milliseconds.

## Messages

| `t` | Who sends it | Body | Meaning |
|---|---|---|---|
| `describe` | every app, on joining and whenever someone else joins | `params: [{id, label, kind, value}]`, `outs: [{id, label}]` | "These are my controls and my outputs." `value` is where each control stands now. |
| `set` | a source | `p`, `v` (0 to 1) | Put control `p` at `v`. |
| `mod` | a source | `p`, `v` (-1 to 1) | Offset control `p` by `v` around wherever its owner left it. `0` ends the modulation. |
| `ramp` | a source | `p`, `pts: [[ms, v], …]`, optional `at` | Move `p` through these points, each taking `ms` to reach `v`. The destination plays it locally. |
| `state` | any app with outputs | `outs: {id: v, …}` | "My outputs are now these." Sent a few times a second, only when they change. |
| `ping` | anyone | `n` | The relay answers `{"t":"pong","n":n,"now":…}`. |

From the relay: `welcome`, `join` (`peer: {id, app, name}`), `leave` (`id`), `pong`, and `error` (`code`: `bad`, `size` or `rate`).

Every message the relay passes on carries `from`, the sender's id, set by the relay. It cannot be forged.

`kind` is `cont` (a continuous control, the default), `toggle` (off below 0.5, on above) or `trig` (fires when it crosses 0.5 going up).

## Addressing

Add `to` to any message you send:

- a peer id: that one connection
- `"app:gaborgrove"`: every copy of that app in the room
- nothing: everyone else

You never receive your own messages.

## Timing

The internet adds delay and jitter, typically 30 to 150 ms.

- **Slow movement** (LFOs, sweeps, a hand on a slider): send `set` or `mod` at 20 to 30 a second. The receiver may smooth.
- **Sharp movement** (envelopes, gates): send one `ramp`. The destination plays the shape against its own clock, so jitter cannot roughen it.
- **Together across machines**: give the ramp an `at` time on the relay's clock, a little in the future (`now + 80`). Each destination converts it to its own clock. Estimate the relay clock from `welcome.now`, refined by `ping`: `offset = pong.now - (sent + received) / 2`.

## Rules for an app that can be moved

1. Clamp every value you receive, even though the relay already has.
2. Ignore controls you do not have.
3. Show that you are linked, and give the person a switch that stops remote control. Local hands win.
4. Treat every label and name as plain text. Never insert one as markup.
5. `mod` is an offset around the local value, not a takeover: when the person moves the slider, that becomes the new centre.

## Limits (the relay enforces these)

| | |
|---|---|
| Connections per room | 16 |
| Message size | 32 KB |
| Controls in one `describe` | 128 |
| Outputs in one `describe` or `state` | 64 |
| Points in one `ramp` | 32, each up to 10 minutes |
| Text fields | 64 characters, control characters removed |
| Rate | 240 at once, refilling at 120 a second, per connection |

Unknown message types and unknown fields are dropped. Values that are not numbers are refused.

## The least a source has to do

A source, such as a mod matrix, needs five things:

1. Open the WebSocket with a room code.
2. Send `{"t":"describe","params":[],"outs":[]}` (it has nothing to be moved, and that is fine).
3. Collect each `describe` it receives: those are its new destinations.
4. For each patched destination, send `set`, `mod` or `ramp` with `to` and `p`.
5. Optionally listen for `state` and treat those outputs as extra sources.

Or load `invisible-hands.js`, which does 1 to 3 and 5:

```js
const hands = InvisibleHands.create({ app: 'mega-cv', name: 'MEGA·CV' });
hands.join('moss-kiln-opal-fern-42');
hands.on('peers', peers => { /* peers[i].params are destinations for the matrix */ });
hands.mod(peer.id, 'spatialFreq', lfoValue);                               // -1..1, as often as 30 a second
hands.ramp(peer.id, 'pullApart', [[40, 1], [900, 0]], hands.serverNow() + 80);
hands.on('state', peer => { /* peer.state.angle and friends, 0..1 */ });
```

## Versions

`welcome.v` is the protocol number. A change that old apps could not ignore will raise it.
