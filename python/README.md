# Invisible Hands for Python

One file, `invisible_hands.py`. Needs `pip install websockets` (and `pip install python-osc` for the OSC bridge). Python 3.9 or newer.

```python
from invisible_hands import Hands

speed = 0.5
def set_speed(v):
    global speed; speed = v

hands = Hands(app='my-tool', name='My Tool')
hands.param('speed', 'Speed', get=lambda: speed, set=set_speed)   # others can move it (0..1)
hands.out('level', 'Level', get=lambda: 0.3)                      # others can listen to it (0..1)
code = hands.start()                                              # a new room; or hands.start('moss-kiln-opal-fern-42')
print('room', code)

hands.wait_linked()
hands.mod('app:gaborgrove', 'spread', 0.2)                        # move someone else's control
```

- `start(code)` runs in a background thread; your `get`/`set` are called from it.
- `start(code, poll=True)` and `hands.poll()` every frame: moves wait for you, in your thread (Blender, TouchDesigner, pygame).
- `await hands.run(code)` inside an asyncio program.
- `hands.on('peers' | 'state' | 'status' | 'in' | 'error', fn)`, `hands.peers`, `hands.allow = False`, `hands.recenter(id)`, `hands.server_now()`, `hands.leave()`.

`hands.status` is `'error'` (and `hands.error` says why) if the relay refuses, for instance when its monthly allowance is used up. It doesn't retry those.

## Command line

No key is needed. (`--key` exists for the rare app the editors gave one.)

```
python invisible_hands.py peers  <room>                          who's there, and their controls
python invisible_hands.py set    <room> app:<slug> <param> 0.7
python invisible_hands.py lfo    <room> app:<slug> <param> --rate 0.5 --depth 0.3 --shape triangle
python invisible_hands.py listen <room>                          print everyone's outputs
python invisible_hands.py osc    <room> --param cutoff --param warp
```

The OSC bridge listens on UDP 9000 and sends to 127.0.0.1:9001 (change with `--listen`, `--host`, `--port`):

| OSC | |
|---|---|
| `/hands/set/<to>/<param> v` → room | `<to>` is `app:<slug>`, a peer id, or `*` |
| `/hands/mod/<to>/<param> v` → room | -1..1 |
| `/hands/ramp/<to>/<param> ms v ms v …` → room | |
| `/hands/param/<id> v` ← room | someone moved one of your `--param` controls |
| `/hands/state/<app>/<out> v` ← room | another app's output |

## Tests

`python3 test_invisible_hands.py` starts the local relay from `../relay` (run `npm install` there once) and checks 26 things, including the browser library moving a Python app.
