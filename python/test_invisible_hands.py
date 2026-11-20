"""Tests for invisible_hands.py against a real relay.

    python3 test_invisible_hands.py                      starts the local relay (../relay, needs npm install) and tests that
    python3 test_invisible_hands.py ws://localhost:8787  tests a relay that is already running
"""
import os
import random
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from invisible_hands import Hands, make_code, clean_code  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))
relay, child = (sys.argv[1] if len(sys.argv) > 1 else None), None
if not relay:
    port = 9400 + random.randint(0, 400)
    child = subprocess.Popen(['node', 'dev-server.mjs'], cwd=os.path.join(here, '..', 'relay'),
                             env=dict(os.environ, PORT=str(port)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    relay = 'ws://127.0.0.1:%d' % port
    time.sleep(0.7)

fails = 0


def ok(cond, what):
    global fails
    print(('ok   ' if cond else 'FAIL ') + what)
    if not cond:
        fails += 1


def until(test, s=2.0):
    t0 = time.time()
    while time.time() - t0 < s:
        if test():
            return True
        time.sleep(0.01)
    return test()


try:
    ok(clean_code(make_code()) is not None, 'a made-up room code is a valid one')
    ok(clean_code('Moss Kiln Opal') == 'moss-kiln-opal', 'room codes are tidied (case, spaces)')
    ok(clean_code('ab') is None and clean_code('no/slash') is None, 'bad room codes are refused')

    room = 'py-' + make_code()
    val = {'speed': 0.5, 'gate': 0.0}
    beat = {'v': 0.25}
    dest = Hands(app='py-dest', name='Destination', relay=relay)
    dest.param('speed', 'Speed', get=lambda: val['speed'], set=lambda v: val.__setitem__('speed', v))
    dest.param('gate', 'Gate', kind='toggle', get=lambda: val['gate'], set=lambda v: val.__setitem__('gate', v))
    dest.out('beat', 'Beat', get=lambda: beat['v'])
    dest.start(room)
    ok(dest.wait_linked(5), 'a destination joins a room')

    src = Hands(app='py-src', name='Source', relay=relay)
    src.start(room)
    ok(src.wait_linked(5), 'a source joins the same room')
    ok(until(lambda: any(p.app == 'py-dest' and len(p.params) == 2 for p in src.peers.values())),
       'the source sees the destination and its two controls')
    peer = next((p for p in src.peers.values() if p.app == 'py-dest'), None)
    ok(peer is not None and peer.params[0]['id'] == 'speed' and abs(peer.params[0]['value'] - 0.5) < 1e-6,
       'describe carries ids and current values')
    ok(peer is not None and peer.params[1]['kind'] == 'toggle', 'describe carries kinds')

    src.set(peer, 'speed', 0.8)
    ok(until(lambda: abs(val['speed'] - 0.8) < 1e-6), 'set moves a control (addressed by peer)')
    src.set('app:py-dest', 'speed', 2.5)
    ok(until(lambda: val['speed'] == 1.0), 'set by app name, and out-of-range values are clamped')
    src.set(None, 'speed', 0.4)
    ok(until(lambda: abs(val['speed'] - 0.4) < 1e-6), 'set to everyone')

    src.mod(peer, 'speed', 0.2)
    ok(until(lambda: abs(val['speed'] - 0.6) < 1e-6), 'mod offsets around where the control stood')
    src.mod(peer, 'speed', -0.3)
    ok(until(lambda: abs(val['speed'] - 0.1) < 1e-6), 'mod keeps the same centre')
    src.mod(peer, 'speed', 0)
    ok(until(lambda: abs(val['speed'] - 0.4) < 1e-6), 'mod 0 returns to the centre')

    src.ramp(peer, 'speed', [(150, 1.0), (150, 0.0)], at=src.server_now() + 50)
    seen = []
    t0 = time.time()
    while time.time() - t0 < 0.6:
        seen.append(val['speed'])
        time.sleep(0.01)
    ok(max(seen) > 0.85 and abs(val['speed']) < 1e-6, 'a timed ramp rises, falls and lands on its last point')

    src.set(peer, 'speed', 0.2); src.set(peer, 'gate', 1.0)      # sent in the same moment: one batch frame
    ok(until(lambda: abs(val['speed'] - 0.2) < 1e-6 and val['gate'] == 1.0), 'moves made together arrive together (batched)')
    src.set(peer, 'gate', 0.0)
    until(lambda: val['gate'] == 0.0)
    val['speed'] = 0.0

    src.set(peer, 'nonsense', 0.5)
    time.sleep(0.2)
    ok(val == {'speed': 0.0, 'gate': 0.0}, 'controls the app does not have are ignored')

    ok(until(lambda: abs(peer.state.get('beat', -1) - 0.25) < 1e-6), "the destination's outputs reach the source")
    beat['v'] = 0.75
    ok(until(lambda: abs(peer.state.get('beat', -1) - 0.75) < 1e-6), 'outputs are re-sent when they change')

    dest.allow = False
    src.set(peer, 'gate', 1.0)
    time.sleep(0.25)
    ok(val['gate'] == 0.0, 'allow = False stops remote moves')
    dest.allow = True

    ok(src.latency is not None and src.latency < 500, 'the clock is synced by ping (latency %s ms)' % src.latency)

    # poll mode: moves wait until poll()
    pv = {'x': 0.0}
    polled = Hands(app='py-poll', name='Polled', relay=relay)
    polled.param('x', get=lambda: pv['x'], set=lambda v: pv.__setitem__('x', v))
    polled.start(room, poll=True)
    ok(polled.wait_linked(5), 'a polled app joins')
    ok(until(lambda: any(p.app == 'py-poll' and p.params for p in src.peers.values())), 'the source sees it')
    src.set('app:py-poll', 'x', 0.9)
    time.sleep(0.3)
    before = pv['x']
    polled.poll()
    ok(before == 0.0 and abs(pv['x'] - 0.9) < 1e-6, 'with poll=True a move waits for poll()')

    # the browser library, run in Node, in the same room
    js = os.path.join(here, '..', 'invisible-hands.js')
    node = subprocess.run(['node', '-e', '''
const fs=require('fs');eval(fs.readFileSync(process.argv[1],'utf8'));
let x=0;const h=InvisibleHands.create({app:'node-js',name:'Node',relay:process.argv[2],autoJoin:false,
  params:[{id:'x',get:()=>x,set:v=>{x=v;}}]});
h.join(process.argv[3]);
h.on('peers',ps=>{const d=ps.find(p=>p.app==='py-dest'&&p.params.length);if(d&&!h.done){h.done=1;h.set(d.id,'speed',0.33);}});
setTimeout(()=>{console.log(JSON.stringify({x:x}));process.exit(0);},1500);
''', js, relay, room], capture_output=True, text=True, timeout=10)
    ok(node.returncode == 0, 'invisible-hands.js runs under Node 22 ' + (node.stderr.strip()[:200]))
    ok(until(lambda: abs(val['speed'] - 0.33) < 1e-6), 'the JS library moves a Python app')

    polled.leave()
    src.leave()
    dest.leave()
    ok(dest.status == 'off' and src.status == 'off', 'leave closes the connection')
finally:
    if child:
        child.terminate()

print('all passed' if not fails else '%d failed' % fails)
sys.exit(1 if fails else 0)
