import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

test('design card tool chooses legal combos, protects existing cards, and reports unresolved references', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'design-card-completion-'))
  try {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', `
      import { db, schema, initDb } from './src/db/index.ts'
      import { eq } from 'drizzle-orm'
      import { buildAgentRequestContext } from './src/agents/context.ts'
      import { promptStoryboardUpdaters } from './src/agents/tools/storyboard-tools.ts'
      import { auditEpisodeDesignCards } from './src/services/design-card-batch.ts'
      initDb()
      const at = '2026-01-01T00:00:00.000Z'
      await db.insert(schema.dramas).values({ id: 1, title: 'project', createdAt: at, updatedAt: at })
      await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'episode', createdAt: at, updatedAt: at })
      await db.insert(schema.props).values({ id: 39, dramaId: 1, name: 'Map', createdAt: at, updatedAt: at })
      await db.insert(schema.episodeProps).values({ episodeId: 1, propId: 39, createdAt: at })
      const oldCard = JSON.stringify({ version: 2, rationale: 'human content', budget: { layer_s: 8, gen_s: null }, layer_plan: { planned_layers: [{ type: 'marker', text: 'river', anchor: { asset_id: 39, semantic_id: 'fiction' } }] } })
      for (const [id, combo, card] of [[1, null, null], [2, 'B', oldCard], [3, null, oldCard], [4, null, null]]) {
        await db.insert(schema.storyboards).values({ id, episodeId: 1, storyboardNumber: id, combo, designCard: card, designCardStatus: card ? 'pending' : 'blank', createdAt: at, updatedAt: at })
      }
      const row = async id => (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)))[0]
      const ctx = (id, only = false) => {
        const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1, storyboardId: id, storyboardPromptScope: 'design_card' })
        rc.set('designCardComboOnly', only)
        return { requestContext: rc }
      }
      const tool = promptStoryboardUpdaters.designCard
      const invoke = (id, card, only = false) => tool.execute({ storyboard_id: id, design_card: card }, ctx(id, only))
      const good = await invoke(1, { combo: 'A', suggested_combo: 'A', rationale: 'new', budget: { layer_s: 8 } })
      const preserved = await invoke(2, { combo: 'C', rationale: 'new' })
      const supplemented = await invoke(3, { combo: 'A', rationale: 'do not overwrite' }, true)
      const invalid = await invoke(4, { combo: 'X' })
      const invented = await invoke(4, { combo: 'A', layer_plan: { planned_layers: [{ type: 'marker', anchor: { asset_id: 39, semantic_id: 'Map' } }] } })
      const audit = await auditEpisodeDesignCards(1)
      process.stdout.write('@@' + JSON.stringify({ good, preserved, supplemented, invalid, invented, rows: await Promise.all([1,2,3,4].map(row)), oldCard, audit }))
    `], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') } })
    const result = JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
    assert.equal(result.rows[0].combo, 'A')
    assert.equal(result.rows[1].combo, 'B')
    assert.equal(result.rows[2].combo, 'A')
    assert.equal(result.rows[2].designCard, result.oldCard)
    assert.equal(result.rows[3].combo, null)
    assert.match(result.invalid.error, /X/)
    assert.match(result.invented.error, /语义/)
    const item = result.audit.find(item => item.storyboard_id === 3)
    assert.equal(item.tts.duration_ms, null)
    assert.equal(item.unresolved_layers[0].asset_id, 39)
    assert.equal(item.unresolved_layers[0].asset_exists, true)
    assert.equal(item.unresolved_layers[0].semantic_id, 'fiction')
    assert.equal(item.unresolved_layers[0].text, 'river')
    assert.deepEqual(item.unresolved_layers[0].available_semantics, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
