/**
 * 模块自带技能的读取（Issue #99）
 *
 * 技能文档随模块发布（`src/modules/map-studio/skills/<name>/SKILL.md`），由 fs 直读：
 * 不经过火宝的技能注册表/工作区，也不受项目级技能目录影响——模块的行为只由模块自己的文件决定。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** dev / tsx：src/modules/map-studio → skills/；桌面版 bundle 旁的 skills/ 也认 */
const SKILL_ROOT_CANDIDATES = [
  path.join(MODULE_DIR, 'skills'),
  path.join(MODULE_DIR, '..', 'skills'),
  path.join(process.cwd(), 'skills'),
]

export class MapStudioSkillMissingError extends Error {
  constructor(public readonly skill: string) {
    super(`地图工作室技能「${skill}」缺失：模块内 skills/${skill}/SKILL.md 不存在`)
    this.name = 'MapStudioSkillMissingError'
  }
}

/** 读一份技能全文；缺失即抛错（绝不带着空技能跑模型） */
export async function loadMapStudioSkill(name: string): Promise<string> {
  for (const root of SKILL_ROOT_CANDIDATES) {
    const file = path.join(root, name, 'SKILL.md')
    try {
      return await fs.promises.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  throw new MapStudioSkillMissingError(name)
}
