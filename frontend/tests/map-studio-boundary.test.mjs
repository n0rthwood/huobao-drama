import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const moduleRoot = join(frontend, 'app/map-studio')
const exact = new Set(['vue', 'vue-i18n', 'vue-sonner', 'lucide-vue-next', '#app', '#imports'])
const infrastructure = new Set(['utils/url', 'composables/useQuerySync', 'composables/useNowTicker', 'composables/useLayerDoc', 'utils/layerSvg'])

function allowed(file, specifier) {
  if (exact.has(specifier)) return true
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier)
    return target === moduleRoot || target.startsWith(moduleRoot + sep)
  }
  if (!specifier.startsWith('~/') && !specifier.startsWith('@/')) return false
  const target = specifier.slice(2).replace(/\.(?:ts|js)$/, '')
  if (target.startsWith('map-studio/')) return !target.split('/').includes('..')
  if (target.startsWith('components/LayerCanvas/')) return !target.split('/').includes('..')
  return infrastructure.has(target)
}

function imports(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      const arg = node.arguments[0]
      found.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<non-literal dynamic import>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.(?:vue|ts|js|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : [])
}

test('Map Studio imports stay inside the module or the infrastructure whitelist', () => {
  const violations = []
  for (const file of files(moduleRoot)) {
    const raw = readFileSync(file, 'utf8')
    const scripts = file.endsWith('.vue') ? [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : raw
    for (const specifier of imports(scripts, file)) if (!allowed(file, specifier)) violations.push(`${relative(frontend, file)}: ${specifier}`)
  }
  assert.deepEqual(violations, [], `Map Studio boundary violations:\n${violations.join('\n')}`)
})

test('Map Studio boundary scanner rejects business and escaping dynamic imports', () => {
  const file = join(moduleRoot, 'components/example.vue')
  assert.equal(allowed(file, '~/composables/useApi'), false)
  assert.equal(allowed(file, '../../composables/useTasks'), false)
  assert.equal(allowed(file, '~/map-studio/../views/drama/detail.vue'), false)
  assert.equal(allowed(file, '../api'), true)
  assert.deepEqual(imports("import('~/composables/useApi'); require('../../views/drama/detail.vue')", file), ['~/composables/useApi', '../../views/drama/detail.vue'])
})
