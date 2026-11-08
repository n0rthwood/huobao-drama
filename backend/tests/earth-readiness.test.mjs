import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const helper = fileURLToPath(new URL('../scripts/earth-map.py', import.meta.url))

// Pure helper regression: no Playwright launch, browser, network, database or production mutation.
test('Earth waits through a late promo and observes File after closing it', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import json, runpy, sys
helpers = runpy.run_path(sys.argv[1])

def node(label, role='button', x=20, y=30):
    return {'label': label, 'role': role, 'x': x, 'y': y, 'w': 40, 'h': 20}

class Page:
    def __init__(self, frames):
        self.frames = list(frames)
        self.current = []
        self.clicks = []
        self.waits = []
        self.mouse = self
        self.keyboard = self
        self.keys = []
    def press(self, key):
        self.keys.append(key)
    def evaluate(self, _script):
        if self.frames:
            self.current = self.frames.pop(0)
        return self.current
    def click(self, x, y):
        self.clicks.append([x, y])
    def wait_for_timeout(self, ms):
        self.waits.append(ms)

# The first poll has no promo. It arrives later, blocks File, then disappears after Close.
page = Page([[], [node('Alert', 'alert'), node('Close', x=120, y=60)], [], [node('File')]])
found = helpers['find'](page, 'File', timeout=6)

# A normal settings panel also has Close, but is NOT a blocking promo. Do not close it
# before the intended Clean button can be selected.
settings = Page([[node('Basemap settings', 'dialog'), node('Close'), node('Clean')]])
clean = helpers['find'](settings, 'Clean', timeout=1)

# Already-enabled semantics must not wait for a placeholder that may never appear.
ready = Page([[node('File')]])
helpers['enable_semantics'](ready, timeout=1)

# A Dismiss-only promo is just as blocking as a Close promo.
dismiss = Page([[node('Alert', 'alert'), node('Dismiss')], [node('File')]])
helpers['find'](dismiss, 'File', timeout=3)

# If clicking did not dismiss the very same dialog, use Escape and keep observing.
stuck = [node('Alert', 'alert'), node('Close')]
escape = Page([stuck, stuck, [node('File')]])
helpers['find'](escape, 'File', timeout=4)
print(json.dumps({'found': found['label'], 'clicks': page.clicks, 'waits': page.waits,
                  'clean': clean['label'], 'settings_clicks': settings.clicks,
                  'ready_waits': ready.waits, 'dismiss_clicks': dismiss.clicks,
                  'escape_keys': escape.keys, 'escape_clicks': escape.clicks,
                  'actions': [item.get('action') for item in escape._huobao_readiness]}))
`, helper], { encoding: 'utf8' }))
  assert.equal(result.found, 'File')
  assert.deepEqual(result.clicks, [[140, 70]], 'Close uses the freshly observed bounding box')
  assert.equal(result.waits.length, 3, 'Readiness is observed again after closing; no one-shot assumption')
  assert.equal(result.clean, 'Clean')
  assert.deepEqual(result.settings_clicks, [], 'Ordinary settings Close must not be mistaken for a promo')
  assert.deepEqual(result.ready_waits, [], 'An already-enabled semantics tree is ready immediately')
  assert.deepEqual(result.dismiss_clicks, [[40, 40]], 'Dismiss-only blocking promos must be dismissed')
  assert.deepEqual(result.escape_keys, ['Escape'], 'A dialog that remains after clicking gets Escape')
  assert.deepEqual(result.escape_clicks, [[40, 40]], 'Do not repeatedly hammer a stuck dialog')
  assert.deepEqual(result.actions, ['Close', 'Escape', null], 'Diagnostic history records each observed action')
})
