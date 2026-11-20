"""Build invisible-hands-kit.zip: everything someone needs to add Invisible Hands to their own app."""
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
FILES = ['README.md', 'SPEC.md', 'GUIDE.md', 'INVISIBLE_HANDS.md', 'invisible-hands.js',
         'console/index.html', 'examples/minimal.html', 'examples/raw-destination.js',
         'examples/go/main.go', 'examples/go/go.mod', 'examples/go/go.sum',
         'python/invisible_hands.py', 'python/README.md', 'python/test_invisible_hands.py',
         'relay/core.js', 'relay/worker.js', 'relay/dev-server.mjs', 'relay/test.mjs',
         'relay/package.json', 'relay/package-lock.json', 'relay/wrangler.toml',
         'brand/ih-mark.svg', 'brand/ih-mark-dark.svg', 'brand/ih-mini.svg', 'brand/ih-mark-mono.svg',
         'brand/ih-wordmark.svg', 'brand/ih-wordmark-line.svg', 'brand/ih-lockup.svg']
out = root / 'invisible-hands-kit.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        info = zipfile.ZipInfo('invisible-hands/' + f, date_time=(2026, 1, 1, 0, 0, 0))   # fixed dates: same files, same zip
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, (root / f).read_bytes())
print('wrote', out.name, out.stat().st_size, 'bytes,', len(FILES), 'files')
