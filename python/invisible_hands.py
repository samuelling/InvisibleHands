"""Invisible Hands for Python. Protocol 1. One file; needs `websockets` (pip install websockets).

Lets a Python program move other apps' controls over the internet, be moved by them, or both, in the same
rooms as the web apps that use invisible-hands.js. See SPEC.md for the messages.

Be moved (a destination):

    from invisible_hands import Hands
    hands = Hands(app='my-synth', name='My Synth')
    hands.param('cutoff', 'Cutoff', get=lambda: synth.cutoff, set=lambda v: setattr(synth, 'cutoff', v))
    hands.out('env', 'Envelope', get=lambda: synth.env)          # optional: what you publish, 0..1
    hands.start('moss-kiln-opal-fern-42')                       # background thread; returns at once

Move others (a source):

    hands = Hands(app='my-lfo', name='My LFO')
    hands.start(code)
    hands.wait_linked()
    hands.mod('app:gaborgrove', 'spatialFreq', 0.3)             # -1..1 around where its owner left it
    hands.ramp('app:gaborgrove', 'pullApart', [(40, 1), (900, 0)], at=hands.server_now() + 80)

Three ways to run it:
    hands.start(code)          a background thread. Your get/set functions are called from that thread.
    hands.start(code, poll=True), then hands.poll() in your own loop: incoming moves wait until you poll,
                               and get/set run in your thread. Good for game loops and single-threaded hosts.
    await hands.run(code)      inside your own asyncio program.

Also a command line: python invisible_hands.py --help  (peers, set, lfo, listen, osc).
"""
import asyncio
import json
import os
import math
import queue
import random
import re
import secrets
import sys
import threading
import time
from urllib.parse import quote

__all__ = ['Hands', 'make_code', 'DEFAULT_RELAY', 'VERSION']

VERSION = 1
DEFAULT_RELAY = 'wss://invisible-hands.samuelling.workers.dev'
WORDS = ('moss kiln opal fern dusk reed salt wren pine silk rust plum mint coal lark dune '
         'echo flax gale haze iris jade kelp loam moth nest onyx peat quay rook sage tide '
         'vole wasp yarn zinc bark clay dove elm fawn glow hush ink jute knot lime mist '
         'nook oat pond rye soot teal umber vine wick yew birch crow drift ember frost grain').split()
ROOM = re.compile(r'^[a-z0-9][a-z0-9-]{3,47}$')
KINDS = ('cont', 'toggle', 'trig')


def make_code():
    """Four words and two digits, easy to read aloud: 'moss-kiln-opal-fern-42'."""
    return '-'.join(secrets.choice(WORDS) for _ in range(4)) + '-' + str(10 + secrets.randbelow(90))


def clean_code(code):
    c = re.sub(r'\s+', '-', str(code or '').strip().lower())
    return c if ROOM.match(c) else None


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _now_ms():
    return time.time() * 1000.0


class _Param:
    __slots__ = ('id', 'label', 'kind', 'get', 'set', 'mod')

    def __init__(self, pid, label, kind, get, set, mod):
        self.id, self.label, self.kind, self.get, self.set, self.mod = pid, label or pid, kind, get, set, mod


class Peer:
    """Another app in the room. `params` and `outs` are lists of dicts as that app described them;
    `state` holds its latest outputs, 0..1. Everything in here came from someone else: use it as plain text."""

    def __init__(self, pid, app, name):
        self.id, self.app, self.name = pid, app, name
        self.params, self.outs, self.state = [], [], {}

    def __repr__(self):
        return 'Peer(%r, app=%r, name=%r, %d params, %d outs)' % (self.id, self.app, self.name, len(self.params), len(self.outs))


class Hands:
    def __init__(self, app='python', name=None, relay=None, key=None, state_hz=15, allow=True):
        """app: a slug for the kind of program. key: optional, only for an app the editors gave one."""
        self.app = str(app)
        self.key = key if key and re.match(r'^ih_[a-z0-9]{20}$', key) else None
        self.error = ''               # why the relay refused, when status is 'error'
        self.name = str(name or app)
        self.relay = (relay or DEFAULT_RELAY).rstrip('/')
        if not re.match(r'^(wss://\S+|ws://(localhost|127\.0\.0\.1)(:\d+)?(/\S*)?)$', self.relay):
            raise ValueError('The relay address must start with wss:// (or ws://localhost for development).')
        self.state_hz = state_hz
        self.allow = allow            # False: nobody else can move this app's controls
        self.room = None
        self.id = None
        self.status = 'off'           # off | connecting | on | retrying | error
        self.peers = {}               # id -> Peer
        self.latency = None           # one-way estimate, ms
        self._params, self._outs = {}, {}
        self._listeners = {}
        self._offset = 0.0            # relay clock minus ours, ms
        self._rtt = None
        self._ramps, self._base, self._sent = {}, {}, {}
        self._send_all = True
        self._can_batch = False
        self._outbox = []
        self._out_lock = threading.Lock()
        self._flush_due = False
        self._last = {}
        self._pings, self._ping_n = {}, 0
        self._ws = None
        self._loop = None
        self._thread = None
        self._stop = None
        self._linked = threading.Event()
        self._inbox = None            # a queue when polling

    # ---- describing this app ----
    def param(self, pid, label=None, get=None, set=None, kind='cont', mod=None):
        """A control others may move. get() returns 0..1; set(v) receives 0..1. kind: cont, toggle or trig.
        mod(v), optional: handle modulation (-1..1) yourself instead of swinging around the current value."""
        if get is None or set is None:
            raise ValueError('param needs get and set')
        if kind not in KINDS:
            raise ValueError('kind is cont, toggle or trig')
        self._params[str(pid)] = _Param(str(pid), label, kind, get, set, mod)
        if self.status == 'on':
            self._call_soon(self._describe)
        return self

    def out(self, oid, label=None, get=None):
        """An output others can listen to. get() returns 0..1."""
        if get is None:
            raise ValueError('out needs get')
        self._outs[str(oid)] = (label or str(oid), get)
        if self.status == 'on':
            self._call_soon(self._describe)
        return self

    def recenter(self, pid):
        """Call when the person moves a control by hand: modulation then swings around the new value."""
        self._base.pop(str(pid), None)
        self._ramps.pop(str(pid), None)

    # ---- events ----
    def on(self, event, fn):
        """event: 'peers' fn(list of Peer), 'state' fn(Peer), 'status' fn(str), 'in' fn(dict), 'error' fn(code)."""
        self._listeners.setdefault(event, []).append(fn)
        return lambda: self._listeners.get(event, []).remove(fn)

    def _emit(self, event, *args):
        for fn in list(self._listeners.get(event, [])):
            try:
                fn(*args)
            except Exception as err:  # one bad listener must not stop the rest
                print('invisible_hands: listener for %r failed: %r' % (event, err), file=sys.stderr)

    def _set_status(self, s):
        if s != self.status:
            self.status = s
            if s == 'on':
                self._linked.set()
            else:
                self._linked.clear()
            self._emit('status', s)

    # ---- clock ----
    def server_now(self):
        """The relay's clock in ms, for timed ramps that start together on every machine."""
        return _now_ms() + self._offset

    # ---- sending ----
    def _target(self, to):
        return to.id if isinstance(to, Peer) else (to or None)

    def _send(self, obj):
        """Moves and outputs wait a moment in an outbox so that those made together leave as one batch frame
        (every frame counts against the relay's allowance, whatever its size). Anything else goes at once."""
        if obj.get('to') is None:
            obj.pop('to', None)
        if self._loop is None or self._ws is None:
            return False
        if obj['t'] in ('set', 'mod', 'ramp', 'state'):
            with self._out_lock:
                self._outbox.append(obj)
                due, self._flush_due = self._flush_due, True
            if not due:
                self._loop.call_soon_threadsafe(self._flush)
            return True
        self._post(json.dumps(obj, separators=(',', ':')))
        return True

    def _flush(self):
        with self._out_lock:
            q, self._outbox, self._flush_due = self._outbox, [], False
        if len(q) == 1 or not self._can_batch:
            for m in q:
                self._post(json.dumps(m, separators=(',', ':')))
            return
        for i in range(0, len(q), 32):
            part = q[i:i + 32]
            self._post(json.dumps(part[0] if len(part) == 1 else {'t': 'batch', 'm': part}, separators=(',', ':')))

    def _post(self, text):
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._loop.create_task(self._raw_send(text))
        else:
            asyncio.run_coroutine_threadsafe(self._raw_send(text), self._loop)

    def _changed(self, kind, to, p, v):
        """The same value to the same control again within a few seconds is not worth a frame."""
        k, now = (kind, to, p), time.monotonic()
        last = self._last.get(k)
        if last and last[0] == v and now - last[1] < 4:
            return False
        self._last[k] = (v, now)
        if len(self._last) > 512:
            self._last.pop(next(iter(self._last)))
        return True

    async def _raw_send(self, text):
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(text)
        except Exception:
            pass

    def set(self, to, p, v):
        """Put control p at v (0..1). to: a peer, a peer id, 'app:<slug>', or None for everyone."""
        to, v = self._target(to), round(clamp(float(v), 0.0, 1.0), 4)
        return self._send({'t': 'set', 'to': to, 'p': p, 'v': v}) if self._changed('s', to, p, v) else True

    def mod(self, to, p, v):
        """Offset control p by v (-1..1) around where its owner left it. 0 ends the modulation."""
        to, v = self._target(to), round(clamp(float(v), -1.0, 1.0), 4)
        return self._send({'t': 'mod', 'to': to, 'p': p, 'v': v}) if self._changed('m', to, p, v) else True

    def ramp(self, to, p, pts, at=None):
        """Move p through [(ms, v), ...]; the far side plays it on its own clock. at: relay-clock start time."""
        m = {'t': 'ramp', 'to': self._target(to), 'p': p,
             'pts': [[clamp(float(ms), 0.0, 600000.0), clamp(float(v), 0.0, 1.0)] for ms, v in pts][:32]}
        if at:
            m['at'] = float(at)
        return self._send(m)

    # ---- what this app says about itself ----
    def _read(self, get):
        try:
            v = float(get())
            return clamp(v, 0.0, 1.0) if math.isfinite(v) else 0.0
        except Exception:
            return 0.0

    def _describe(self, to=None):
        m = {'t': 'describe',
             'params': [{'id': p.id, 'label': p.label, 'kind': p.kind, 'value': self._read(p.get)} for p in self._params.values()],
             'outs': [{'id': k, 'label': lab} for k, (lab, _) in self._outs.items()]}
        if to:
            m['to'] = to
        self._send(m)

    def _publish(self):
        if self.status != 'on' or not self.peers or not self._outs:
            return
        full = self._send_all          # everything when someone new arrives, otherwise only what moved
        o = {}
        for k, (_, get) in self._outs.items():
            v = self._read(get)
            if full or k not in self._sent or abs(v - self._sent[k]) > 0.002:
                o[k] = round(v, 4)
                self._sent[k] = v
        self._send_all = False
        if o:
            self._send({'t': 'state', 'outs': o})

    # ---- what arrives ----
    def _apply(self, m):
        """Apply one set/mod/ramp. Runs in the background thread, or in poll()."""
        p = self._params.get(m.get('p'))
        if p is None or not self.allow:
            return
        t = m['t']
        if t == 'set' and _num(m.get('v')):
            self._ramps.pop(p.id, None)
            v = clamp(float(m['v']), 0.0, 1.0)
            self._base[p.id] = v
            self._safe(p.set, v)
        elif t == 'mod' and _num(m.get('v')):
            v = clamp(float(m['v']), -1.0, 1.0)
            if p.mod is not None:
                self._safe(p.mod, v)
            else:
                if p.id not in self._base:
                    self._base[p.id] = self._read(p.get)
                self._safe(p.set, clamp(self._base[p.id] + v, 0.0, 1.0))
        elif t == 'ramp' and isinstance(m.get('pts'), list) and m['pts']:
            pts = []
            for q in m['pts'][:32]:
                if isinstance(q, list) and len(q) == 2 and _num(q[0]) and _num(q[1]):
                    pts.append((clamp(float(q[0]), 0.0, 600000.0), clamp(float(q[1]), 0.0, 1.0)))
            if not pts:
                return
            t0 = (float(m['at']) - self._offset) if _num(m.get('at')) else _now_ms()
            self._ramps[p.id] = {'t0': t0, 'from': self._read(p.get), 'pts': pts, 'total': sum(d for d, _ in pts)}
        else:
            return
        self._emit('in', {'from': m.get('from'), 'p': p.id, 't': t})

    def _tick_ramps(self):
        if not self._ramps:
            return
        now = _now_ms()
        for pid, r in list(self._ramps.items()):
            p = self._params.get(pid)
            if p is None:
                self._ramps.pop(pid, None)
                continue
            t = now - r['t0']
            v = r['from']
            if t >= r['total']:
                v = r['pts'][-1][1]
                self._ramps.pop(pid, None)
                self._base[pid] = v
            elif t > 0:
                acc, prev = 0.0, r['from']
                for d, target in r['pts']:
                    if t <= acc + d:
                        v = prev + (target - prev) * (t - acc) / d if d > 0 else target
                        break
                    acc += d
                    prev = target
            self._safe(p.set, clamp(v, 0.0, 1.0))

    def _safe(self, fn, v):
        try:
            fn(v)
        except Exception as err:
            print('invisible_hands: a control raised %r' % (err,), file=sys.stderr)

    def poll(self):
        """With start(..., poll=True): apply waiting moves and advance ramps, in the calling thread.
        Call it every frame, or at least 30 times a second."""
        if self._inbox is not None:
            while True:
                try:
                    self._apply(self._inbox.get_nowait())
                except queue.Empty:
                    break
        self._tick_ramps()

    def _on_message(self, raw):
        try:
            m = json.loads(raw)
        except ValueError:
            return
        if not isinstance(m, dict):
            return
        t = m.get('t')
        peer = self.peers.get(m.get('from'))
        if t == 'welcome':
            self.id = m.get('id')
            self._offset = (float(m['now']) if _num(m.get('now')) else _now_ms()) - _now_ms()
            self._can_batch = bool(m.get('batch'))
            self._last.clear()
            self._pings_due = [time.monotonic() + 1.5, time.monotonic() + 4]
            self.peers = {}
            for q in m.get('peers') or []:
                if isinstance(q, dict) and q.get('id'):
                    self.peers[q['id']] = Peer(q['id'], str(q.get('app', '')), str(q.get('name', '')))
            self._set_status('on')
            self._describe()
            self._ping()
            self._emit('peers', list(self.peers.values()))
        elif t == 'join':
            q = m.get('peer') or {}
            if q.get('id'):
                self.peers[q['id']] = Peer(q['id'], str(q.get('app', '')), str(q.get('name', '')))
                self._describe(q['id'])
                self._send_all = True
                self._last.clear()
                self._emit('peers', list(self.peers.values()))
        elif t == 'leave':
            if self.peers.pop(m.get('id'), None):
                self._emit('peers', list(self.peers.values()))
        elif t == 'describe' and peer:
            peer.params = [q for q in (m.get('params') or []) if isinstance(q, dict) and isinstance(q.get('id'), str)]
            peer.outs = [q for q in (m.get('outs') or []) if isinstance(q, dict) and isinstance(q.get('id'), str)]
            self._emit('peers', list(self.peers.values()))
        elif t == 'state' and peer and isinstance(m.get('outs'), dict):
            for k, v in m['outs'].items():
                if _num(v):
                    peer.state[k] = clamp(float(v), 0.0, 1.0)
            self._emit('state', peer)
        elif t in ('set', 'mod', 'ramp'):
            if self._inbox is not None:
                self._inbox.put(m)
            else:
                self._apply(m)
        elif t == 'pong' and m.get('n') in self._pings:
            now = _now_ms()
            trip = now - self._pings.pop(m['n'])
            if _num(m.get('now')) and (self._rtt is None or trip <= self._rtt * 1.5):
                self._rtt = trip if self._rtt is None else min(self._rtt, trip) * 0.7 + trip * 0.3
                self._offset = float(m['now']) - (now - trip / 2)
                self.latency = round(self._rtt / 2)
        elif t == 'error':
            if m.get('why'):
                self._why = str(m['why'])[:160]
            self._emit('error', m.get('code'))

    def _ping(self):
        self._ping_n += 1
        self._pings[self._ping_n] = _now_ms()
        if len(self._pings) > 20:
            self._pings.pop(min(self._pings))
        self._send({'t': 'ping', 'n': self._ping_n})

    # ---- the connection ----
    def _url(self):
        return '%s/room/%s?app=%s&name=%s%s' % (self.relay, self.room, quote(self.app, safe=''), quote(self.name, safe=''),
                                              '&key=' + self.key if self.key else '')

    async def run(self, code):
        """Join a room and stay in it until leave() (reconnecting when the line drops). For asyncio programs."""
        try:
            from websockets.asyncio.client import connect
        except ImportError:  # websockets older than 13
            from websockets import connect
        c = clean_code(code)
        if not c:
            raise ValueError('Room codes are 4 to 48 letters, digits and hyphens.')
        self.room = c
        self._loop = asyncio.get_running_loop()
        self._stop = asyncio.Event()
        tries = 0
        self._pings_due = []
        self._why = ''
        self.error = ''

        async def chores():
            # three pings to learn the relay's clock, then one every five minutes: clocks drift slowly
            last_ping = time.monotonic()
            while not self._stop.is_set():
                if self._inbox is None:
                    self._tick_ramps()
                self._publish()
                now = time.monotonic()
                if self.status == 'on' and (now - last_ping > 300 or (self._pings_due and now >= self._pings_due[0])):
                    if self._pings_due and now >= self._pings_due[0]:
                        self._pings_due.pop(0)
                    self._ping()
                    last_ping = now
                await asyncio.sleep(1 / 60 if self._ramps else 1 / max(1, self.state_hz))

        chore_task = asyncio.create_task(chores())
        try:
            while not self._stop.is_set():
                self._set_status('retrying' if tries else 'connecting')
                try:
                    async with connect(self._url(), max_size=65536, open_timeout=10) as ws:
                        self._ws = ws
                        tries = 0
                        stop_wait = asyncio.create_task(self._stop.wait())
                        while True:
                            recv = asyncio.create_task(ws.recv())
                            done, _ = await asyncio.wait({recv, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
                            if stop_wait in done:
                                recv.cancel()
                                break
                            self._on_message(recv.result())
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    code = getattr(getattr(err, 'rcvd', None), 'code', None)
                    if code in (4001, 4003, 4008, 4029):   # refused for a reason retrying won't fix
                        self.error = self._why or {4029: "The relay has used its allowance for this month.",
                                                   4008: 'Too many messages: the relay closed the line.'}.get(code, 'The relay did not accept this key.')
                        self._ws = None
                        self._set_status('error')
                        print('invisible_hands: ' + self.error, file=sys.stderr)
                        break
                    busy = code == 4030               # too many new connections: wait a minute
                else:
                    busy = False
                self._ws = None
                self.id = None
                if self.peers:
                    self.peers = {}
                    self._emit('peers', [])
                if self._stop.is_set():
                    break
                tries += 1
                self._set_status('retrying')
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=60.0 if busy else min(15.0, 0.5 * 2 ** min(tries, 5)))
                except asyncio.TimeoutError:
                    pass
        finally:
            chore_task.cancel()
            self._ws = None
            self._ramps.clear()
            self._base.clear()
            self._sent = {}
            self.room = None
            if self.status != 'error':
                self._set_status('off')

    def start(self, code=None, poll=False):
        """Join a room from a background thread and return at once. code: a room code, or None for a new one.
        poll=True: incoming moves wait for poll(), so your get/set functions run in your own thread.
        Returns the room code."""
        if self._thread and self._thread.is_alive():
            self.leave()
        code = code or make_code()
        if not clean_code(code):
            raise ValueError('Room codes are 4 to 48 letters, digits and hyphens.')
        self._inbox = queue.Queue() if poll else None
        ready = threading.Event()

        def main():
            async def go():
                self._loop = asyncio.get_running_loop()
                ready.set()
                await self.run(code)
            asyncio.run(go())

        self._thread = threading.Thread(target=main, name='invisible-hands', daemon=True)
        self._thread.start()
        ready.wait(5)
        return clean_code(code)

    def wait_linked(self, timeout=10):
        """Block until linked to the room (True) or timeout (False)."""
        return self._linked.wait(timeout)

    def leave(self):
        """Leave the room and close the connection."""
        if self._loop and self._stop:
            try:
                self._loop.call_soon_threadsafe(self._stop.set)
            except RuntimeError:
                pass
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(5)
        self._thread = None

    def _call_soon(self, fn):
        if self._loop:
            try:
                self._loop.call_soon_threadsafe(fn)
            except RuntimeError:
                pass

    def invite_url(self, page):
        """An address for a web app that joins this room by itself: invite_url('https://example.org/app/')."""
        if not self.room:
            return ''
        sep = '&' if '?' in page else '?'
        return '%s%sroom=%s' % (page, sep, self.room)


# ---------------------------------------------------------------------------------------------------------
# Command line: python invisible_hands.py <command> ROOM [options]
# ---------------------------------------------------------------------------------------------------------
def _cli(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog='invisible_hands', description='Invisible Hands from the command line.')
    ap.add_argument('--relay', default=DEFAULT_RELAY, help='relay address (default: %(default)s)')
    ap.add_argument('--key', default=os.environ.get('INVISIBLE_HANDS_KEY'), help='optional: a key the editors gave you (or set INVISIBLE_HANDS_KEY)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    a = sub.add_parser('peers', help='list the apps in a room and their controls')
    a.add_argument('room')

    a = sub.add_parser('set', help='put one control at a value')
    a.add_argument('room'); a.add_argument('to', help="a peer id, app:<slug>, or '*' for everyone")
    a.add_argument('param'); a.add_argument('value', type=float)

    a = sub.add_parser('lfo', help='swing a control with an LFO until Ctrl-C')
    a.add_argument('room'); a.add_argument('to'); a.add_argument('param')
    a.add_argument('--rate', type=float, default=0.25, help='Hz (default 0.25)')
    a.add_argument('--depth', type=float, default=0.3, help='0..1 (default 0.3)')
    a.add_argument('--shape', choices=['sine', 'triangle', 'square', 'saw', 'random'], default='sine')

    a = sub.add_parser('listen', help="print the room's outputs as they change")
    a.add_argument('room')

    a = sub.add_parser('osc', help='bridge a room to OSC (Max, Pd, TouchDesigner, Live, SuperCollider)')
    a.add_argument('room')
    a.add_argument('--listen', type=int, default=9000, help='UDP port to receive OSC on (default 9000)')
    a.add_argument('--host', default='127.0.0.1', help='where to send OSC (default 127.0.0.1)')
    a.add_argument('--port', type=int, default=9001, help='UDP port to send OSC to (default 9001)')
    a.add_argument('--param', action='append', default=[], metavar='ID',
                   help='offer a control others can move; arrives as /hands/param/ID (repeatable)')
    a.add_argument('--name', default='OSC bridge')
    args = ap.parse_args(argv)

    to = None if getattr(args, 'to', None) in (None, '*') else args.to

    if args.cmd == 'peers':
        h = Hands(app='cli', name='Command line', relay=args.relay, key=args.key)
        h.start(args.room)
        if not h.wait_linked():
            sys.exit(h.error or 'Could not reach the relay.')
        time.sleep(1.2)
        if not h.peers:
            print('Nobody else is in', h.room)
        for p in h.peers.values():
            print('%s  %s (%s)' % (p.id, p.name, p.app))
            for q in p.params:
                print('    param %-24s %-6s %s' % (q['id'], q.get('kind', 'cont'), q.get('value', '')))
            for q in p.outs:
                print('    out   %s' % q['id'])
        h.leave()

    elif args.cmd == 'set':
        h = Hands(app='cli', name='Command line', relay=args.relay, key=args.key)
        h.start(args.room)
        if not h.wait_linked():
            sys.exit(h.error or 'Could not reach the relay.')
        time.sleep(0.4)  # let the room describe itself first
        h.set(to, args.param, args.value)
        time.sleep(0.3)
        h.leave()

    elif args.cmd == 'lfo':
        h = Hands(app='cli-lfo', name='Command-line LFO', relay=args.relay, key=args.key)
        h.start(args.room)
        if not h.wait_linked():
            sys.exit(h.error or 'Could not reach the relay.')
        print('Swinging %s on %s. Ctrl-C to stop.' % (args.param, to or 'everyone'))
        t0, held, last_step = time.monotonic(), 0.0, -1
        try:
            while True:
                ph = ((time.monotonic() - t0) * args.rate) % 1.0
                if args.shape == 'sine':
                    s = math.sin(2 * math.pi * ph)
                elif args.shape == 'triangle':
                    s = 1 - 4 * abs(ph - 0.5)
                elif args.shape == 'square':
                    s = 1.0 if ph < 0.5 else -1.0
                elif args.shape == 'saw':
                    s = 2 * ph - 1
                else:
                    step = int((time.monotonic() - t0) * args.rate)
                    if step != last_step:
                        held, last_step = random.uniform(-1, 1), step
                    s = held
                h.mod(to, args.param, args.depth * s)
                time.sleep(1 / 25)
        except KeyboardInterrupt:
            h.mod(to, args.param, 0)
            time.sleep(0.2)
            h.leave()

    elif args.cmd == 'listen':
        h = Hands(app='cli', name='Command-line listener', relay=args.relay, key=args.key)
        h.on('state', lambda p: print('%-20s %s' % (p.name[:20], '  '.join('%s=%.3f' % kv for kv in sorted(p.state.items())))))
        h.on('peers', lambda ps: print('-- in the room:', ', '.join(p.name for p in ps) or 'nobody'))
        h.start(args.room)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            h.leave()

    elif args.cmd == 'osc':
        try:
            from pythonosc.dispatcher import Dispatcher
            from pythonosc.osc_server import ThreadingOSCUDPServer
            from pythonosc.udp_client import SimpleUDPClient
        except ImportError:
            sys.exit('The OSC bridge needs python-osc:  pip install python-osc')
        out = SimpleUDPClient(args.host, args.port)
        h = Hands(app='osc-bridge', name=args.name, relay=args.relay, key=args.key)
        values = {}
        for pid in args.param:
            values[pid] = 0.0

            def setter(v, pid=pid):
                values[pid] = v
                out.send_message('/hands/param/' + pid, float(v))
            h.param(pid, pid, get=lambda pid=pid: values[pid], set=setter)
        h.on('state', lambda p: [out.send_message('/hands/state/%s/%s' % (p.app, k), float(v)) for k, v in p.state.items()])

        def from_osc(address, *vals):
            # /hands/set/<to>/<param> v    /hands/mod/<to>/<param> v    /hands/ramp/<to>/<param> ms v ms v ...
            parts = address.strip('/').split('/')
            if len(parts) != 4 or parts[0] != 'hands' or not vals:
                return
            verb, dest, param = parts[1], parts[2], parts[3]
            dest = None if dest == '*' else ('app:' + dest[4:] if dest.startswith('app-') else dest)
            if verb == 'set':
                h.set(dest, param, vals[0])
            elif verb == 'mod':
                h.mod(dest, param, vals[0])
            elif verb == 'ramp' and len(vals) >= 2:
                h.ramp(dest, param, list(zip(vals[0::2], vals[1::2])))
        disp = Dispatcher()
        disp.set_default_handler(from_osc)
        srv = ThreadingOSCUDPServer(('127.0.0.1', args.listen), disp)
        code = h.start(args.room)
        print('Room %s. OSC in on udp %d, out to %s:%d. Ctrl-C to stop.' % (code, args.listen, args.host, args.port))
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            srv.shutdown()
            h.leave()


if __name__ == '__main__':
    _cli()
