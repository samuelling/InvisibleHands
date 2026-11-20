# Invisible Hands: notes for Claude working on this repo

This repo is the source of Invisible Hands and its website. (To add Invisible Hands to some other app, read `INVISIBLE_HANDS.md` instead.)

- **The website is this repo on GitHub Pages**, from `main`, root: https://samuelling.github.io/InvisibleHands/. `index.html` is the landing page (megaZINE look: same tokens and fonts as megazine.org), `console/` the console, and every file is downloadable from there. People link `invisible-hands.js` straight from it, so `main` must always work: run both test suites before pushing.
  - `cd relay && npm install && npm test`
  - `cd python && python3 test_invisible_hands.py` (needs `pip install websockets`)
- `invisible-hands-kit.zip` is generated: rerun `python3 tools/make_kit.py` and commit it with any change to the files it holds.
- Keep `invisible-hands.js`, `python/invisible_hands.py`, `SPEC.md`, `GUIDE.md` and `INVISIBLE_HANDS.md` in step. A change to how messages behave goes into all of them in the same commit.
- Cloudflare cost: the bill is incoming frames (20 bill as one request) plus a request per connection and two per room report. Rooms report to the meter at most once a minute and only after something happened (frames, a join, a leave): never add timers, heartbeats or periodic re-sends to rooms or clients. `dashboard/` shows the month.
- The relay at `wss://invisible-hands.samuelling.workers.dev` runs on Sam's Cloudflare account. The `Deploy relay` workflow deploys it on every push to `main` that touches `relay/` (tests first, including `test-worker.mjs` under `wrangler dev`), using the repo secrets `CLOUDFLARE_API_TOKEN` and `ADMIN_TOKEN`. So a push to `relay/` is a deploy: make one only when Sam asks for the change. Never print the secrets; the Actions logs are public.
- Protocol changes that old apps couldn't ignore raise `PROTOCOL` / `VERSION` (in `relay/core.js`, both clients, and `SPEC.md`). Avoid them.
- It is in megaZINE (Issue 03, December 2026; repo `megazinehq/megazinehq.github.io`, work id `invisible-hands`). Don't change the site's address: the paper's code points at it through megazine.org.
- Voice: plain, short, present tense. Other people's names, brands and products stay out of the page, as on megaZINE.
