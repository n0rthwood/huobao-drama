import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'
import ts from 'typescript'

const backend = fileURLToPath(new URL('..', import.meta.url))
const root = path.join(backend, 'src/modules/asset-studio')
const allowed = new Set([
 'db/index.js','utils/paths.js','utils/storage.js','utils/response.js','utils/task-logger.js',
 'services/ai-stages.js','services/ai.js','services/vision-chat.js','services/task-observability.js','services/semantics-geometry.js',
])
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : item.name.endsWith('.ts') ? [path.join(dir, item.name)] : [])
}

test('Asset Studio backend imports stay inside its infrastructure boundary (including dynamic imports)', () => {
  const violations = []
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8')
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const specifiers = []
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifiers.push(node.moduleSpecifier)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifiers.push(node.arguments[0])
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifiers.push(node.argument.literal)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const node of specifiers) {
      if (!node || !ts.isStringLiteralLike(node)) { violations.push(`${path.relative(backend, file)}: non-literal import`); continue }
      const specifier = node.text
      if (isBuiltin(specifier)) continue
      if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
        if (['hono', 'zod', 'sharp', 'better-sqlite3', 'drizzle-orm'].includes(specifier) || specifier.startsWith('@mastra/')) continue
        violations.push(`${path.relative(backend, file)}: ${specifier}`)
        continue
      }
      const resolved = path.resolve(path.dirname(file), specifier)
      if (resolved.startsWith(root + path.sep)) continue
      const relative = path.relative(path.join(backend, 'src'), resolved)
      if (!allowed.has(relative)) violations.push(`${path.relative(backend, file)}: ${specifier}`)
      if (relative === 'db/index.js' && ts.isImportDeclaration(node.parent)) {
        const clause = node.parent.importClause
        const names = clause?.namedBindings
        if (clause?.name || names && (!ts.isNamedImports(names) || names.elements.some(item => !['sqlite', 'getInsertId'].includes(item.propertyName?.text ?? item.name.text)))) violations.push(`${path.relative(backend, file)}: ${specifier} may expose only sqlite/getInsertId`)
      }
    }
    if (/\bschema\s*\./.test(source)) violations.push(`${path.relative(backend, file)}: schema. business-table access`)
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})
