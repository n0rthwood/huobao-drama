import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const helper = fileURLToPath(new URL('../scripts/earth-map.py', import.meta.url))

// State regression only; actual Flutter/Google Earth import is verified separately.
test('Earth survives sequential and delayed onboarding without leaving the editor', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import json, runpy, sys
helpers = runpy.run_path(sys.argv[1])

def node(label, ident, role='button'):
    # Tooltip semantics may publish old screen coordinates during animation.
    return {'id':ident, 'label':label, 'role':role, 'x':4, 'y':123, 'w':40, 'h':20}

class Page:
    def __init__(self, settings=False):
        self.settings=settings
        self.started=False
        self.screen='settings' if settings else 'editor'
        self.promos=['modal', 'hint-one', 'hint-two']
        self.pending_animation=True
        self.mouse=self
        self.keyboard=self
    def evaluate(self, script, ident=None):
        if ident is not None:
            if self.settings:
                self.screen='closed'
            elif self.promos and ident==self.promos[0]:
                if ident=='hint-one' and self.pending_animation:
                    self.pending_animation=False
                else:
                    self.promos.pop(0)
            return True
        if self.settings:
            return [node('Close','settings-close'),node('Clean','clean')]
        if self.screen!='editor':
            return [node('Map projects','projects')]
        if not self.started:
            self.started=True
            return []
        if self.promos:
            ident=self.promos[0]
            return ([node('Alert','alert','alert'),node('Close',ident)] if ident=='modal'
                    else [node('File','file'),node('Dismiss',ident)])
        return [node('File','file')]
    def click(self, x, y):
        # A stale tooltip hitbox targets the underlying project navigation.
        self.screen='projects'
    def press(self, key):
        # Escape on a tooltip is a global editor-exit shortcut, not dismissal.
        if key=='Escape': self.screen='projects'
    def wait_for_timeout(self, ms):
        pass

page=Page()
found=helpers['find'](page,'File',timeout=10)
settings=Page(settings=True)
clean=helpers['find'](settings,'Clean',timeout=1)
print(json.dumps({'found':found['label'],'screen':page.screen,
                  'unresolved_promos':page.promos,'clean':clean['label'],
                  'settings_screen':settings.screen}))
`, helper], { encoding: 'utf8' }))
  assert.equal(result.found, 'File')
  assert.equal(result.screen, 'editor', 'Onboarding must not navigate to project management')
  assert.deepEqual(result.unresolved_promos, [], 'Every blocking hint must be resolved before exposing the editor')
  assert.equal(result.clean, 'Clean')
  assert.equal(result.settings_screen, 'settings', 'A normal settings Close is not an onboarding blocker')
})

test('Earth waits for an observed import when a late coachmark consumes the open action', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import json, runpy, sys
helpers = runpy.run_path(sys.argv[1])

def node(label, ident):
    return {'id':ident,'label':label,'role':'button','x':0,'y':0,'w':40,'h':20}

class Page:
    def __init__(self):
        self.menu=False
        self.hint=False
        self.swallow_next=True
        self.pending_hint=False
        self.picker={'requested':0,'file_reads':0}
        self.pickers_shown=[]
        self.keyboard=self
    def evaluate(self, script, ident=None):
        if ident is None:
            if '__huobaoPicker' in script:
                return self.picker
            result=[node('File','file')]
            if self.menu: result.append(node('Open local KML file\\\\nCtrl+I','open'))
            if self.hint: result.append(node('Dismiss','dismiss'))
            return result
        if ident=='dismiss':
            self.hint=False
            self.menu=False
        elif ident=='file':
            self.menu=not self.menu
        elif ident=='open':
            if self.swallow_next:
                # A coachmark appears after the menu click and eats the action.
                self.swallow_next=False
                self.pending_hint=True
            elif not self.hint:
                self.picker['requested']+=1
                self.picker['file_reads']+=1
                self.menu=False
        return True
    def press(self, key):
        if key == 'Control+I' and self.menu:
            self.picker['requested']+=1
            self.picker['file_reads']+=1
            self.menu=False
        elif key == 'Escape':
            self.screen='projects'
    def wait_for_timeout(self, ms):
        pass
    def wait_for_function(self, script, timeout):
        if self.pending_hint:
            self.pending_hint=False
            self.hint=True
        elif not self.picker['requested']:
            raise TimeoutError('No picker and no observed blocker: retry')

page=Page()
helpers['open_local_kml'](page)
print(json.dumps({'picker':page.picker,'hint':page.hint,'menu':page.menu,'screen':'editor'}))
`, helper], { encoding: 'utf8' }))
  assert.equal(result.picker.file_reads, 1, 'The swallowed first click must not count as import')
  assert.equal(result.picker.requested, 1, 'A resolved blocker must not reopen the picker twice')
  assert.equal(result.hint, false, 'The late coachmark must be dismissed before retrying')
})
