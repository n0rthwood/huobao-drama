/**
 * 纪录片用例的「当前有效配音」夹具（Issue #70）。
 *
 * #70 之后，纪录片逐镜制作（关键帧 / 图层段 / 视频 / 合成）要求本镜有当前有效配音：
 * 旁白文本、生效配音参数、音频文件与实测时长四者都要对得上。既有的制作类用例原本
 * 只建分镜不建配音，所以统一用这个夹具把它们的纪录片剧集补成「已配音」状态，
 * 而不是把门禁改松。
 *
 * 在子进程脚本里这样用（cwd = backend）：
 *   const { giveShotsValidVoice } = await import('./tests/fixtures/documentary-voice.mjs')
 *   await giveShotsValidVoice({ episodeId, storyboardIds: [1, 2, 3] })
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { eq, inArray } from 'drizzle-orm'

const DEFAULT_TEXT = '一七二〇年，清、准、俄三方都在这片草原上押下重注。'

/**
 * 让这些分镜拥有当前有效配音：补 TTS 配置、打开剧集旁白、写旁白文本、
 * 生成真实 wav 并按**当前生效参数**写 narration_meta。
 *
 * `confirmSkeleton`（默认开）还会把剧本正文补成各镜旁白的顺序拼接，并确认旁白稿与旁白骨架——
 * 批量配音与设计卡填写以「骨架已确认」为前置，制作类用例需要这份完整事实。
 */
export async function giveShotsValidVoice({ episodeId, storyboardIds, seconds = 3, text = DEFAULT_TEXT, confirmSkeleton = true }) {
  const { db, schema } = await import('../../src/db/index.ts')
  const { sha256 } = await import('../../src/services/narration.ts')
  const gate = await import('../../src/services/narration-tts-gate.ts')

  const ts = new Date().toISOString()
  const existing = await db.select().from(schema.aiServiceConfigs)
  let config = existing.find(row => row.serviceType === 'tts')
  if (!config) {
    await db.insert(schema.aiServiceConfigs).values({
      name: 'tts fixture', serviceType: 'tts', provider: 'voxcpm',
      baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: JSON.stringify(['voxcpm']),
      settings: JSON.stringify({ voice: 'fixture-voice' }),
      isActive: true, priority: 1, createdAt: ts, updatedAt: ts,
    })
    config = (await db.select().from(schema.aiServiceConfigs)).find(row => row.serviceType === 'tts')
  }

  await db.update(schema.episodes)
    .set({ narrationEnabled: true, ttsConfigId: config.id, updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId))
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const params = gate.effectiveVoiceParams(episode, null, config)

  const ffmpegBin = createRequire(path.join(process.cwd(), 'tests-entry.cjs'))('ffmpeg-static')
  const dataRoot = process.env.HUOBAO_DATA_DIR
  const dir = path.join(dataRoot, 'static/narration')
  fs.mkdirSync(dir, { recursive: true })

  const rows = await db.select().from(schema.storyboards).where(inArray(schema.storyboards.id, storyboardIds))
  const srtTime = (sec) => {
    const ms = Math.round(sec * 1000)
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  }
  for (const sb of rows) {
    const narration = (sb.narrationText || '').trim() || text
    const rel = `static/narration/fixture-${sb.id}.wav`
    const srtRel = `static/narration/fixture-${sb.id}.srt`
    execFileSync(ffmpegBin, [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), path.join(dataRoot, rel),
    ], { stdio: 'ignore' })
    // 合成要求字幕存在且有字幕行：真实配音链路会一并产出字幕，夹具照做
    fs.writeFileSync(path.join(dataRoot, srtRel), `1\n${srtTime(0)} --> ${srtTime(seconds)}\n${narration}\n\n`, 'utf8')
    await db.update(schema.storyboards).set({
      narrationEnabled: true,
      narrationText: narration,
      narrationAudioUrl: rel,
      subtitleUrl: srtRel,
      narrationMeta: JSON.stringify({
        text_sha256: sha256(narration),
        audio: {
          duration_ms: seconds * 1000, chars: narration.length, voice: params.voice,
          seed: params.seed, job_id: null, provider: 'voxcpm', config_id: config.id,
          generated_at: ts, text_sha256: sha256(narration), params,
        },
        subtitle: { cues: 1, source: 'sentence', timing: 'sentence', generated_at: ts },
      }),
      updatedAt: ts,
    }).where(eq(schema.storyboards.id, sb.id))
  }

  if (confirmSkeleton) {
    const live = (await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)))
      .filter(sb => !sb.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    if (live.length && live.every(sb => (sb.narrationText || '').trim())) {
      // 剧本正文 = 各镜旁白的顺序拼接：骨架确认要求逐字、有序、不重不漏
      await db.update(schema.episodes).set({
        scriptContent: live.map(sb => sb.narrationText.trim()).join('\n\n'),
        scriptConfirmedAt: ts,
        updatedAt: ts,
      }).where(eq(schema.episodes.id, episodeId))
      const skeleton = await import('../../src/services/narration-skeleton.ts')
      const state = await skeleton.narrationSkeletonState(episodeId)
      if (state.confirmable) await skeleton.confirmNarrationSkeleton(episodeId, state.revision)
    }
  }
  return { params, seconds }
}
