/**
 * Issue #30 的结构性约束：开关关闭 = 行为不变、旁白链路的接线、TTS 服务类型。
 */
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const exists = (p) => existsSync(new URL(p, root))

test('数据模型：新列都有默认值，存量行等价于功能关闭', () => {
  const sqlite = read('src/db/sqlite-schema.ts')
  assert.match(sqlite, /episodes', column: 'narration_enabled', type: 'INTEGER NOT NULL DEFAULT 0'/)
  assert.match(sqlite, /storyboards', column: 'narration_enabled', type: 'INTEGER NOT NULL DEFAULT 1'/)
  for (const col of ['tts_config_id', 'subtitle_timing']) {
    assert.ok(sqlite.includes(`column: '${col}'`), `缺少 episodes.${col} 补列`)
  }
  for (const col of ['narration_text', 'narration_audio_url', 'narration_meta', 'subtitle_timing']) {
    assert.ok(sqlite.includes(`column: '${col}'`), `缺少 storyboards.${col} 补列`)
  }
  // 字幕时间码默认分句边界（用户确认 Q10）
  assert.match(sqlite, /subtitle_timing', type: "TEXT NOT NULL DEFAULT 'sentence'"/)
  assert.match(read('src/services/narration.ts'), /DEFAULT_SUBTITLE_TIMING: SubtitleTiming = 'sentence'/)
})

test('TTS 服务类型与 voxcpm 适配器接线完整', () => {
  const ai = read('src/services/ai.ts')
  assert.match(ai, /export type ServiceType = 'text' \| 'image' \| 'video' \| 'tts'/)
  assert.match(ai, /tts: \['voxcpm'\]/)
  // 历史约束：ai.ts 不得再出现旧的 audio 服务类型
  assert.doesNotMatch(ai, /audio/)

  const configs = read('src/routes/aiConfigs.ts')
  assert.match(configs, /p === 'voxcpm'/)
  assert.match(configs, /\/api\/status/)

  const tts = read('src/services/tts.ts')
  assert.match(tts, /\/v1\/audio\/speech/)
  // 实测 VoxCPM2 拒绝 speed，请求体里绝不出现这个键
  assert.doesNotMatch(tts, /\bspeed:/)
  assert.doesNotMatch(tts, /body\.speed/)
  assert.match(tts, /x-job-id/)
  assert.match(tts, /timestamps\?level=/)
})

test('旁白写作 Agent 注册齐全，且只写旁白三字段', () => {
  const agents = read('src/agents/index.ts')
  assert.match(agents, /narration_writer: \{/)
  assert.match(agents, /narration_writer: narrationTools/)
  assert.match(read('src/agents/skills.ts'), /narration_writer: \['narration-writer\/narration-script'\]/)

  const tools = read('src/agents/tools/narration-tools.ts')
  assert.match(tools, /id: 'save_narrations'/)
  for (const forbidden of ['videoPrompt', 'firstFramePrompt', 'sceneId', 'atmosphere']) {
    assert.ok(!tools.includes(forbidden), `save_narrations 不得写 ${forbidden}`)
  }

  assert.ok(exists('workspace/prompts/narration_writer.md'))
  assert.ok(exists('workspace/skills/narration-writer/narration-script/SKILL.md'))
  assert.ok(exists('workspace/skills/storyboard-breaker/narration/SKILL.md'))
  assert.ok(exists('workspace/skills/prompt-generator/video-prompt-narration/SKILL.md'))
})

test('条件技能只在开关打开时注入，关闭时注入内容不变', () => {
  const skills = read('src/agents/skills.ts')
  assert.match(skills, /CONDITIONAL_SKILLS/)
  assert.match(skills, /'storyboard-breaker\/narration': 'narrationEnabled'/)
  assert.match(skills, /'prompt-generator\/video-prompt-narration': 'narrationEnabled'/)
  assert.match(skills, /conditions\[flag\] !== true\) return false/)
  assert.match(read('src/agents/context.ts'), /narrationEnabled/)
  assert.match(read('src/routes/agent.ts'), /narrationEnabled: ep\?\.narrationEnabled === true/)
  assert.match(read('src/services/video-prompts.ts'), /narrationEnabled: ep\?\.narrationEnabled === true/)
})

test('旁白不再写进 description / video_prompt（条件技能文案）', () => {
  const breakdown = read('workspace/skills/storyboard-breaker/narration/SKILL.md')
  assert.match(breakdown, /再写「旁白：…」/)
  const videoPrompt = read('workspace/skills/prompt-generator/video-prompt-narration/SKILL.md')
  assert.match(videoPrompt, /把任何解说词、画外音、旁白写进/)
})

test('任务中心：三个集级 kind 都有中文标签', () => {
  const label = read('src/services/task-label.ts')
  for (const [kind, text] of [['narration_script', '旁白写作'], ['narration_tts', '旁白配音'], ['shot_compose', '分镜合成']]) {
    assert.ok(label.includes(`${kind}: '${text}'`), `任务标签缺少 ${kind}`)
  }
  const textTask = read('src/services/text-task.ts')
  for (const kind of ['narration_script', 'narration_tts', 'shot_compose']) {
    assert.ok(textTask.includes(`'${kind}'`), `TextTaskKind 缺少 ${kind}`)
  }
})

test('接口白名单：剧集与分镜的旁白字段可写，字幕/合成地址仍只由服务写', () => {
  const episodes = read('src/routes/episodes.ts')
  assert.match(episodes, /'narration_enabled', 'tts_config_id', 'subtitle_timing'/)
  assert.match(episodes, /generate-narration/)
  assert.match(episodes, /narration\/voice-batch/)
  assert.match(episodes, /compose-batch/)

  const storyboards = read('src/routes/storyboards.ts')
  assert.match(storyboards, /narration_text: 'narrationText'/)
  assert.match(storyboards, /narration_enabled' in body/)
  // 这两个地址只能由合成/配音服务写
  assert.doesNotMatch(storyboards, /subtitle_url: 'subtitleUrl'/)
  assert.doesNotMatch(storyboards, /composed_video_url: 'composedVideoUrl'/)
  assert.match(read('src/services/storyboard-fields.ts'), /'narration_text'/)
})
