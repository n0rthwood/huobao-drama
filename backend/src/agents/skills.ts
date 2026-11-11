/**
 * Agent 工作区（Workspace）— Mastra 原生能力
 * 每个 Agent 一个 Workspace：
 * - filesystem：jail 到 backend/workspace/ 目录，Agent 获得文件读写工具
 * - skills：从 workspace/skills/ 下注册各 Agent 专属的 SKILL.md
 * 注入 instructions 时仍拼接技能全文（原生注入只有元数据，全文注入保证行为一致）
 *
 * 注意：filesystem instructions 刻意覆写为无 "workspace" 字样的中文描述——
 * 默认文案含绝对路径（路径里有 workspace 目录名），Gemini 系低思考档位下
 * 偶发把其脑补成 Google Workspace 然后以"组织政策"为由拒绝调用工具。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Workspace, LocalFilesystem } from '@mastra/core/workspace'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// 桌面版由 Electron 主进程注入 WORKSPACE_PATH（userData 下的可写副本）；dev 锚定 backend/workspace
const WORKSPACE_DIR = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.resolve(__dirname, '../../workspace')
const SKILLS_DIR = path.join(WORKSPACE_DIR, 'skills')

// 覆写默认 filesystem instructions（默认文案带绝对路径，暴露 workspace 字样）
const FILESYSTEM_INSTRUCTIONS =
  '本地文件目录：用于读写技能定义、提示词等项目文件。相对路径均以此目录为根解析；文件访问仅限此目录之内。'
const localFilesystem = () => new LocalFilesystem({ basePath: WORKSPACE_DIR, instructions: FILESYSTEM_INSTRUCTIONS })

// 启动时确保工作目录存在（Agent 文件读写的 jail 根）
// 桌面版打包后模块可能仍从只读位置加载，失败不阻断启动（路由层会给出明确报错）
try {
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
} catch (err) {
  console.warn(`[skills] 工作目录创建失败（只读环境？）: ${(err as Error).message}`)
}

/** 每个 Agent 注册的 skill 目录（相对 workspace/skills/，含子规范目录；目录名需符合 Agent Skills 规范：小写+连字符） */
const AGENT_SKILL_MAP: Record<string, string[]> = {
  script_rewriter: ['script-rewriter'],
  extractor: ['extractor'],
  storyboard_breaker: [
    'storyboard-breaker',
    'prompt-generator/keyframe-prompt',
    'prompt-generator/video-prompt-narration',
  ],
  prompt_generator: [
    'prompt-generator/character-prompt',
    'prompt-generator/scene-prompt',
    'prompt-generator/prop-prompt',
    'prompt-generator/video-prompt',
    'prompt-generator/video-prompt-narration',
    'prompt-generator/keyframe-prompt',
  ],
  transition_writer: ['prompt-generator/transition-prompt'],
  narration_writer: ['narration-writer/narration-script'],
}

/**
 * 条件注入的技能（#30）：只在满足条件时才拼进 instructions。
 * 它们仍在 AGENT_SKILL_MAP 的前缀范围内（Workspace 能发现、设置页能编辑），
 * 但 loadAgentSkills 会按 requestContext 的标志过滤——开关关闭时注入内容与改动前逐字相同。
 */
const CONDITIONAL_SKILLS: Record<string, keyof SkillConditions> = {
  'storyboard-breaker/narration': 'narrationEnabled',
  'prompt-generator/video-prompt-narration': 'narrationEnabled',
}

export interface SkillConditions {
  /** 本集是否启用旁白（剧集级开关） */
  narrationEnabled?: boolean
}

/**
 * 题材规则集的附加技能目录（Issue #32）— 基础技能正文一字不改，命中题材时叠加。
 * 非纪录片项目零影响：loadAgentSkills 只在 opts.genreRuleset 命中时才注入这些目录。
 */
const GENRE_SKILL_MAP: Record<string, Record<string, string[]>> = {
  documentary: {
    extractor: ['documentary/documentary-extraction'],
    prompt_generator: [
      'documentary/documentary-character-prompt',
      'documentary/documentary-scene-prompt',
      'documentary/documentary-prop-prompt',
    ],
  },
}

/**
 * 项目类型的附加技能目录（Issue #45）— 只对 `project_type='documentary'` 的项目注入。
 * 这两份技能描述的是 narration-first 工作流（旁白逐字取自剧本、两栏脚本），
 * 与之配套的是按 project_type 切换的工具变体；靠 `documentary_rules` 打开纪录片规则的
 * drama 项目（如 drama 3）工具里没有 narration_text 字段，注入这两份技能会前后矛盾，
 * 所以**不能**挂在 GENRE_SKILL_MAP 上。
 */
const PROJECT_TYPE_SKILL_MAP: Record<string, Record<string, string[]>> = {
  documentary: {
    // 旁白优先的剧本整理：剧本正文就是旁白稿，不做对白化改写
    script_rewriter: ['documentary/documentary-script'],
    // 两栏脚本纪律 + 表达设计（#49）：信息点 → device → must_show → overlay_plan；
    // #96 的模板文本框规则只在设计卡阶段真正用到（骨架阶段不写视觉），随同一 Agent 注入
    storyboard_breaker: [
      'documentary/documentary-storyboard',
      'documentary/documentary-keyframe-prompt',
      'documentary/layer-text-design',
    ],
    // 关键帧/视频提示词按 device 分支（#49）：map_anim/archival 不写扩散提示词，
    // 再现类镜头必须覆盖 must_show 并允许承接上一镜
    prompt_generator: ['documentary/documentary-keyframe-prompt'],
  },
}

/** 某 Agent 在所有题材 / 项目类型下可能用到的附加目录（Workspace 的 skills 解析器要能发现它们） */
function genrePrefixes(agentType: string): string[] {
  return [...Object.values(GENRE_SKILL_MAP), ...Object.values(PROJECT_TYPE_SKILL_MAP)]
    .flatMap(byAgent => byAgent[agentType] || [])
}

/** 每个 Agent 的 Workspace（filesystem 工作目录 + 原生技能注册）
 *  skills 用动态解析器按目录前缀匹配：设置页新建的子技能无需重启即可被发现 */
export const skillWorkspaces: Record<string, Workspace> = Object.fromEntries(
  Object.entries(AGENT_SKILL_MAP).map(([agentType, basePrefixes]) => {
    // 题材 addendum 目录也要能被 workspace.skills 解析到（注入与否由 loadAgentSkills 决定）
    const prefixes = [...basePrefixes, ...genrePrefixes(agentType)]
    return [
      agentType,
      new Workspace({
        id: `workspace-${agentType}`,
        name: `${agentType} workspace`,
        filesystem: localFilesystem(),
        skills: () => scanSkillPaths().filter(p =>
          prefixes.some(prefix => p === `skills/${prefix}` || p.startsWith(`skills/${prefix}/`))),
      }),
    ]
  }),
)

/** 递归扫描 workspace/skills/ 下所有含 SKILL.md 的目录（相对 workspace 根的路径） */
function scanSkillPaths(): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (fs.existsSync(path.join(full, 'SKILL.md'))) found.push(`skills/${rel}`)
      walk(full, rel)
    }
  }
  walk(SKILLS_DIR, '')
  return found
}

/**
 * 技能管理 Workspace（设置页 CRUD 用）
 * skills 用动态解析器，新建/删除技能目录后无需重启即可发现
 */
export const skillsManagerWorkspace = new Workspace({
  id: 'workspace-skills-manager',
  name: 'skills manager',
  filesystem: localFilesystem(),
  skills: () => scanSkillPaths(),
})

function formatSkillSection(skillId: string, content: string): string {
  return [`## Skill: ${skillId}`, content].join('\n')
}

/** 剥离 SKILL.md 风格文件的 frontmatter，返回正文（供语言变体直读使用） */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return (m ? raw.slice(m[0].length) : raw).trim()
}

/** 读取技能的语言变体正文（SKILL.<lang>.md，直读绕缓存永远最新）；不存在返回 null */
async function readLocalizedSkill(relPath: string, lang: string): Promise<string | null> {
  const fsm = skillsManagerWorkspace.filesystem!
  const p = `skills/${relPath}/SKILL.${lang}.md`
  try {
    if (!await fsm.exists(p)) return null
    const body = stripFrontmatter(String(await fsm.readFile(p, { encoding: 'utf-8' })))
    return body || null
  } catch {
    return null
  }
}

/**
 * 单个技能目录的正文（Issue #55）：不属于任何 Agent 的技能（如 `documentary/asset-review`）
 * 由服务直接读取拼进 system 消息，因此不进 AGENT_SKILL_MAP，也就不污染其它 Agent 的注入内容。
 * lang 非 zh 时优先 `SKILL.<lang>.md`，缺失回退中文 `SKILL.md`；目录不存在返回空串。
 */
export async function loadSkillDoc(relPath: string, lang?: string | null): Promise<string> {
  if (lang && lang !== 'zh') {
    const localized = await readLocalizedSkill(relPath, lang)
    if (localized) return localized
  }
  const fsm = skillsManagerWorkspace.filesystem!
  const p = `skills/${relPath}/SKILL.md`
  try {
    if (!await fsm.exists(p)) return ''
    return stripFrontmatter(String(await fsm.readFile(p, { encoding: 'utf-8' })))
  } catch {
    return ''
  }
}

/** 读取 Agent 专属技能全文（经 workspace.skills API，保持原注入格式）
 *  AGENT_SKILL_MAP 的目录按前缀匹配：目录自身及其子目录下所有 SKILL.md 都会注入，
 *  因此设置页新建的子技能（如 storyboard-breaker/xxx）无需改代码即可生效。
 *  CONDITIONAL_SKILLS 里的目录只在对应条件为真时注入（#30 的旁白规范）。
 *  opts.genreRuleset 命中时额外叠加 GENRE_SKILL_MAP 的 addendum 目录（Issue #32），
 *  排在基础技能之后，作为覆盖层阅读；未命中时技能文本与改动前逐字一致。
 *  lang 非 zh 时逐技能优先 SKILL.<lang>.md，缺失回退基础版（中文） */
export async function loadAgentSkills(
  agentType: string,
  lang?: string | null,
  opts: SkillConditions & { genreRuleset?: string | null; projectType?: string | null } = {},
): Promise<string> {
  const workspace = skillWorkspaces[agentType]
  const basePrefixes = AGENT_SKILL_MAP[agentType] || []
  const addendumPrefixes = opts.genreRuleset ? (GENRE_SKILL_MAP[opts.genreRuleset]?.[agentType] || []) : []
  const projectPrefixes = opts.projectType ? (PROJECT_TYPE_SKILL_MAP[opts.projectType]?.[agentType] || []) : []
  const prefixes = [...basePrefixes, ...addendumPrefixes, ...projectPrefixes]
  if (!workspace || !prefixes.length) return ''

  const allPaths = scanSkillPaths().map(p => p.replace(/^skills\//, ''))
  // 按 prefixes 顺序分组：基础技能在前，题材 addendum（#32）在后；条件技能（#30）仅在条件为真时注入
  const conditions: SkillConditions = opts
  const relPaths = prefixes.flatMap(prefix =>
    allPaths.filter(p => p === prefix || p.startsWith(prefix + '/')))
    .filter((p) => {
      for (const [condPath, flag] of Object.entries(CONDITIONAL_SKILLS)) {
        if ((p === condPath || p.startsWith(condPath + '/')) && conditions[flag] !== true) return false
      }
      return true
    })

  const useLocalized = Boolean(lang && lang !== 'zh')
  const contents: string[] = []
  for (const relPath of relPaths) {
    let body: string | null | undefined
    if (useLocalized) body = await readLocalizedSkill(relPath, lang!)
    if (!body) {
      const skill = await workspace.skills?.get(`skills/${relPath}`)
      body = skill?.instructions?.trim()
    }
    if (body) contents.push(formatSkillSection(relPath, body))
  }

  if (!contents.length) return ''

  return [
    '以下是该 Agent 专属的项目技能规范（SKILL.md）。',
    '不同 Agent 会加载不同 skill；你只需要遵守当前注入的这些技能。',
    '你必须在不违背当前工具边界的前提下优先遵守这些规范；若与用户明确要求冲突，以用户要求为准。',
    '',
    contents.join('\n\n'),
  ].join('\n')
}

/**
 * 强制重新扫描全部 Agent 的技能（SKILL.md 编辑后调用）
 * maybeRefresh 负责感知目录增删（动态 resolver 路径变化），refresh 负责内容更新
 * （目录 mtime 不会因文件内容编辑而更新，单靠 maybeRefresh 的 staleness 检查不可靠）
 */
export async function refreshSkillWorkspaces(): Promise<void> {
  await Promise.all(
    [...Object.values(skillWorkspaces), skillsManagerWorkspace]
      .map(async workspace => {
        await workspace.skills?.maybeRefresh()
        await workspace.skills?.refresh()
      }),
  )
}
