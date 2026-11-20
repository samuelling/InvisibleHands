# Invisible Hands by hand

For people adding Invisible Hands themselves, in any language. If you'd rather have Claude do it, give it `INVISIBLE_HANDS.md`. The exact rules are in `SPEC.md`; this is the walk-through.

The whole thing is JSON text over one WebSocket. If your language can open a WebSocket and parse JSON, it can join.

## Ready-made

| Language | File | Status |
|---|---|---|
| JavaScript (browser, Node 22+) | `invisible-hands.js` | The reference. Everything, including the panel. |
| Python 3.9+ | `python/invisible_hands.py` | Everything, plus a command line and an OSC bridge. Tested. |
| JavaScript, no library | `examples/raw-destination.js` | 40 lines, to read. Tested. |
| Go | `examples/go/main.go` | A destination, about 90 lines. Tested. |
| Swift | below | A sketch, not yet compiled. |
| Max, Pd, Live, TouchDesigner, SuperCollider | the Python OSC bridge | Tested with python-osc. |

## A conversation on the wire

Two apps in room `moss-kiln-opal-fern-42`: a grove of shapes (the destination) and an LFO (the source). `→` is what an app sends, `←` what the relay sends it.

```
GROVE opens  wss://invisible-hands.samuelling.workers.dev/room/moss-kiln-opal-fern-42?app=grove&name=Grove
GROVE ←  {"t":"welcome","v":1,"batch":true,"id":"p7m2zd","now":1795000000000,"peers":[]}
GROVE →  {"t":"describe","params":[{"id":"spread","label":"Spread","kind":"cont","value":0.4}],"outs":[{"id":"sway","label":"Sway"}]}

LFO opens    …/room/moss-kiln-opal-fern-42?app=lfo&name=LFO
LFO   ←  {"t":"welcome","v":1,"id":"k3x9qa","now":1795000004210,"peers":[{"id":"p7m2zd","app":"grove","name":"Grove"}]}
LFO   →  {"t":"describe","params":[],"outs":[]}
GROVE ←  {"t":"join","peer":{"id":"k3x9qa","app":"lfo","name":"LFO"}}
GROVE →  {"t":"describe","to":"k3x9qa","params":[{"id":"spread","label":"Spread","kind":"cont","value":0.4}],"outs":[{"id":"sway","label":"Sway"}]}
LFO   ←  {"t":"describe","from":"p7m2zd","params":[…],"outs":[…]}          now the LFO knows what it can move

LFO   →  {"t":"mod","to":"app:grove","p":"spread","v":0.2}                   up to 25 times a second, only when it changes
LFO   →  {"t":"batch","m":[{"t":"mod","to":"app:grove","p":"spread","v":0.3},{"t":"set","to":"app:grove","p":"hue","v":0.6}]}
GROVE ←  {"t":"mod","from":"k3x9qa","p":"spread","v":0.3}                    a batch arrives as separate messages
GROVE ←  {"t":"set","from":"k3x9qa","p":"hue","v":0.6}
GROVE ←  {"t":"mod","from":"k3x9qa","p":"spread","v":0.2}                    spread shows 0.4 + 0.2 = 0.6
LFO   →  {"t":"ramp","to":"app:grove","p":"spread","pts":[[40,1],[900,0]],"at":1795000009300}
GROVE →  {"t":"state","outs":{"sway":0.731}}                                  a few times a second, when it changes
LFO   ←  {"t":"state","from":"p7m2zd","outs":{"sway":0.731}}
LFO   →  {"t":"ping","n":3}
LFO   ←  {"t":"pong","n":3,"now":1795000010022}
LFO closes
GROVE ←  {"t":"leave","id":"k3x9qa"}
```

`from` is added by the relay and can't be forged. `to` is a peer id, `app:<slug>`, or left out for everyone else. You never get your own messages back.

## Writing a destination

1. **Connect** to `wss://<relay>/room/<code>?app=<slug>&name=<url-encoded name>`. Room codes are 4 to 48 of `a-z 0-9 -`, starting with a letter or digit. No key is needed. On a close, reconnect with backoff (0.5 s, 1 s, 2 s … up to 15 s), **except** after codes 4001, 4003, 4008 or 4029: those mean "no", so stop and show the `why` from the `error` message that came just before. After 4030, wait a minute.
2. **On `welcome`**, remember `id`, set your clock offset to `welcome.now - yourNowMs`, and send `describe` with every control's current value (0..1) and your outputs.
3. **On `join`**, send `describe` again with `to` set to the newcomer's id.
4. **On `set`**: clamp `v` to 0..1, stop any ramp on that control, apply it, and remember it as the control's **base**.
5. **On `mod`**: clamp `v` to -1..1. If there's no base yet, take the control's current value as base. Apply `clamp(base + v, 0, 1)`. Don't change the base. When the person moves the control by hand, forget the base (the next `mod` takes the new position).
6. **On `ramp`**: play it (below).
7. **Ignore** controls you don't have, message types you don't know, and everything while the person has remote control switched off.
8. **Publish outputs** with `state` at most 15 times a second, only the ones that changed by more than ~0.002, rounded to 4 decimals, and all of them once when someone joins. Nothing when nothing moved.
9. **Show** that you're linked, and give the person a switch to stop remote control.

### Playing a ramp

```
start = (at present) ? at - offset : now           # at is on the relay's clock
from  = the control's value when the ramp arrived
every frame:
    t = now - start
    if t <= 0:            value = from
    elif t >= sum(ms):    value = last point's v, then stop and make it the base
    else: walk the points, each [ms, v] going from the previous value to v over ms; interpolate linearly
```

A new `set` or `ramp` on the same control replaces a running ramp.

### Clock

`offset = relay - local`. Start with `welcome.now - local`, then refine with `ping`: send `{"t":"ping","n":k}` and note the local send time; when `pong` returns, `trip = now - sent`, and if `trip` is no worse than 1.5 × your best so far, `offset = pong.now - (now - trip/2)`. Ping three times in the first few seconds, then every 5 minutes. More often only costs frames.

## Writing a source

1. Connect and `describe` with empty lists (or with your own controls, if you have some).
2. Keep a table of peers from `welcome.peers`, `join`, `leave`, and each `describe` (`from` tells you whose).
3. Send `set`/`mod` for slow movement at most 20 to 25 per second per control, only on change; one `ramp` for any sharp shape, with `at = relayNow + 80` to start every copy together. Moves made in the same tick go in one `batch` frame (if `welcome.batch` is true): every frame costs the same, whatever its size.
4. Stay under the relay's rate: a burst of 240, refilling at 120 per second per connection. Over that you get `{"t":"error","code":"rate"}` and messages are dropped; keep it up and the connection is closed (4008).
5. Send `mod` with `0` when you stop. Re-send current values when someone joins.

## Swift (a sketch)

Not yet compiled; a starting point for an iPhone app. `URLSessionWebSocketTask` is built in.

```swift
import Foundation

final class InvisibleHands {
    struct Param { let id: String; let label: String; var get: () -> Double; var set: (Double) -> Void }
    private var task: URLSessionWebSocketTask?
    private var params: [String: Param] = [:]
    private var base: [String: Double] = [:]
    var allow = true

    init(params: [Param]) { for p in params { self.params[p.id] = p } }

    func join(room: String, app: String, name: String,
              relay: String = "wss://invisible-hands.samuelling.workers.dev") {
        var c = URLComponents(string: "\(relay)/room/\(room)")!
        c.queryItems = [URLQueryItem(name: "app", value: app), URLQueryItem(name: "name", value: name)]
        task = URLSession.shared.webSocketTask(with: c.url!)
        task?.resume()
        receive()
    }

    private func send(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }

    private func describe(to: String? = nil) {
        var m: [String: Any] = ["t": "describe", "outs": [],
            "params": params.values.map { ["id": $0.id, "label": $0.label, "kind": "cont", "value": min(1, max(0, $0.get()))] }]
        if let to = to { m["to"] = to }
        send(m)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            if case .success(.string(let s)) = result,
               let m = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] {
                DispatchQueue.main.async { self.handle(m) }
            }
            if case .failure = result { return }   // reconnect with backoff here
            self.receive()
        }
    }

    private func handle(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "welcome": describe()
        case "join": if let p = m["peer"] as? [String: Any], let id = p["id"] as? String { describe(to: id) }
        case "set":
            guard allow, let id = m["p"] as? String, let p = params[id], let v = m["v"] as? Double else { return }
            let x = min(1, max(0, v)); base[id] = x; p.set(x)
        case "mod":
            guard allow, let id = m["p"] as? String, let p = params[id], let v = m["v"] as? Double else { return }
            let b = base[id] ?? p.get(); base[id] = b; p.set(min(1, max(0, b + min(1, max(-1, v)))))
        default: break   // add ramp, state and ping following the steps above
        }
    }
}
```

## Testing your client

- Open the console at `https://samuelling.github.io/InvisibleHands/console/?room=<code>` with the same room: your controls should appear, the sliders and LFO buttons should move them, and your outputs should meter.
- Or from a terminal: `python invisible_hands.py peers <code>` lists what's in the room, `python invisible_hands.py lfo <code> app:<slug> <param>` swings one control, `python invisible_hands.py listen <code>` prints outputs.
- For a local relay: `cd relay && npm install && npm run dev`, then use `ws://localhost:8787` as the relay.
