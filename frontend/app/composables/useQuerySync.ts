/**
 * 视图子状态 ↔ URL query 同步（deeplink 支持，Issue #86）
 * - 读取：queryEnum / queryTypedId / queryIdList 做白名单校验，非法/缺失返回 null，由调用方回退默认值
 * - 写入：useDeeplink 分组 + 全应用单一 store，以 router.replace 合并写出——子状态（面板/页签/
 *   弹窗）用 push 会在历史栈里堆积导致返回键困在视图内部，replace 保证返回键始终 = 退出当前
 *   视图回到上一页；代价是 Back/Forward 不逐态回放（有意为之）
 * - URL 显式携带子状态时优先于 localStorage 记忆（由各视图在初始化时处理）
 */

import type { Ref } from 'vue'

/** query 单值：数组取首个，trim 后空串视为缺失 */
export function querySingle(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v
  const str = typeof s === 'string' ? s.trim() : ''
  return str || null
}

/** query 枚举值：不在白名单内返回 null（调用方静默回退默认值） */
export function queryEnum(v: unknown, allowed: readonly string[]): string | null {
  const s = querySingle(v)
  return s && allowed.includes(s) ? s : null
}

/** query 形如 character-3 的「类型-id」（资产详情弹窗）；格式非法返回 null */
export function queryTypedId(v: unknown, allowedTypes: readonly string[]): { type: string, id: number } | null {
  const s = querySingle(v)
  if (!s) return null
  const m = new RegExp(`^(${allowedTypes.join('|')})-(\\d+)$`).exec(s)
  return m ? { type: m[1], id: Number(m[2]) } : null
}

/** query 逗号分隔的正整数 id 列表（多选上下文）；非法项丢弃，空列表返回 [] */
export function queryIdList(v: unknown): number[] {
  const s = querySingle(v)
  if (!s) return []
  const out: number[] = []
  for (const part of s.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

// useQuerySync() 旧入口已随 Issue #86 移除：所有子状态改由下面的 deeplink store 统一发布，
// 页面不再各自整包覆盖 query（旧入口的 replace 语义原样保留在 store 的 flush 里）。

/**
 * 嵌套 deeplink 的 query 所有权（Issue #86）
 *
 * 单一所有者：全应用只有一个 store 在写 URL。页面、面板、弹窗、弹窗内子层各注册一个
 * 「分组」并只声明自己的键；store 把所有分组合并后用同一次 router.replace 写出，
 * 父子各写各的键、互不抹除（§6）。严禁任何组件再直接 router.replace({ query }) 写子状态。
 *
 * 键归属：分组声明 keys 后，首次 set 之前 URL 里的原始值保留在 pending 中——
 * 这样异步数据还没就绪、子层还没恢复时，链接里的深层参数不会被父级的同步冲掉（§4）。
 * 分组卸载（release）会移除它的全部键：关闭子层即逐层回到父级定位，父级键原样保留（§2）。
 *
 * 路由 path 变化 = 换了一个工作位置：重新取快照、清空分组值并暂停写出，直到新页面
 * hydrate()。跨路由常驻的组件（如顶栏任务中心）可 watch routeEpoch 重新发布自己的键。
 */
export interface DeeplinkGroup {
  /** 当前路由进入时的快照；用户交互后不再用于恢复，避免后来打开的宿主复活旧弹窗 */
  initial: (key: string) => string | null
  /** 发布本分组当前键值全集：空/缺省值即从 URL 移除 */
  set: (values: Record<string, string | number | null | undefined | false>) => void
  /** 卸载本分组（移除它的全部键）；组件 scope 销毁时自动调用 */
  release: () => void
}

interface DeeplinkStore {
  group: (name: string, keys: readonly string[], persistent: boolean) => DeeplinkGroup
  hydrate: () => void
  initial: (key: string) => string | null
  /** 路由 path 变化计数：常驻组件据此重新发布自己的键 */
  routeEpoch: Ref<number>
}

function snapshotQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(query)) {
    const v = querySingle(query[key])
    if (v) out[key] = v
  }
  return out
}

let store: DeeplinkStore | null = null

/** store 是进程内单例（SPA，ssr: false）：首次在某个 setup 里取得 router 后一直复用 */
function ensureStore(): DeeplinkStore {
  if (store) return store
  const router = useRouter()
  const current = () => router.currentRoute.value
  let initialQuery = snapshotQuery(current().query as Record<string, unknown>)
  // 还没被任何分组接管的初始键：子层恢复完成前原样保留
  const pending = new Map<string, string>(Object.entries(initialQuery))
  // 以「注册令牌」为键，不用分组名：同名分组在路由切换时可能新旧并存
  //（新页面已注册、旧页面 scope 后销毁），用名字会让旧实例把新实例的键删掉
  const groups = new Map<object, { name: string, values: Record<string, string> }>()
  const routeEpoch = ref(0)
  let hydrated = false
  let restorationCancelled = false
  const initialValue = (key: string) => restorationCancelled ? null : initialQuery[key] ?? null
  // 用户的新操作优先；快照本身保留不变，但之后挂载的子层不能再次消费旧位置。
  if (typeof document !== 'undefined') {
    const cancelRestoration = () => { restorationCancelled = true }
    document.addEventListener('click', cancelRestoration, true)
    document.addEventListener('keydown', cancelRestoration, true)
  }
  let dirty = false

  function flush() {
    if (!hydrated) { dirty = true; return }
    const query: Record<string, string> = {}
    for (const [key, value] of pending) query[key] = value
    for (const entry of groups.values()) Object.assign(query, entry.values)
    const cur = current().query
    const keys = Object.keys(query)
    if (keys.length === Object.keys(cur).length && keys.every(k => cur[k] === query[k])) return
    router.replace({ query })
  }

  // 换路由 = 换工作位置：重新取快照并暂停写出，等新页面恢复完成后再 hydrate。
  // store 是进程内单例，这个 watcher 必须挂在独立 scope 上：否则它会被绑到「第一个
  // 调用 useDeeplink 的组件」的 effect scope，那个组件一卸载（例如从 default 布局
  // 跨到 studio 布局的工作台）watcher 就被销毁，之后换路由再也不会重置快照。
  effectScope(true).run(() => {
    watch(() => current().path, () => {
      hydrated = false
      dirty = false
      restorationCancelled = false
      initialQuery = snapshotQuery(current().query as Record<string, unknown>)
      pending.clear()
      for (const [key, value] of Object.entries(initialQuery)) pending.set(key, value)
      for (const entry of groups.values()) entry.values = {}
      routeEpoch.value += 1
    })
  })

  store = {
    routeEpoch,
    initial: initialValue,
    hydrate() {
      if (hydrated) return
      hydrated = true
      if (dirty || Object.keys(initialQuery).length) flush()
    },
    group(name, keys, persistent) {
      const token = {}
      groups.set(token, { name, values: {} })
      const own = [...keys]
      // 分组属于注册时所在的路由：旧页面卸载途中的延迟 set 不得污染新页面的 URL；
      // 跨路由常驻分组（顶栏抽屉）每次发布时认领当前路由
      let epoch = routeEpoch.value
      return {
        initial: (key: string) => (own.includes(key) ? initialValue(key) : null),
        set(values) {
          if (persistent) epoch = routeEpoch.value
          const entry = groups.get(token)
          if (!entry || epoch !== routeEpoch.value) return
          const next: Record<string, string> = {}
          for (const key of own) {
            const raw = values[key]
            const str = raw === null || raw === undefined || raw === false ? '' : String(raw)
            if (str) next[key] = str
            // 本分组已接管该键：pending 里的初始值不再兜底
            pending.delete(key)
          }
          entry.values = next
          flush()
        },
        release() {
          const stale = epoch !== routeEpoch.value
          if (!groups.delete(token) || stale) return
          // 其他分组可能仍在用同名键（切路由时新旧实例并存），只清本实例没人接管的兜底值
          const stillOwned = new Set<string>()
          for (const entry of groups.values()) for (const key of Object.keys(entry.values)) stillOwned.add(key)
          for (const key of own) if (!stillOwned.has(key)) pending.delete(key)
          flush()
        },
      }
    },
  }
  return store
}

/**
 * 注册一个 deeplink 分组（页面、面板、弹窗各自调用）：组件卸载时自动释放自己的键。
 * keys 必须取自 DEEPLINK_KEYS 的登记表，避免跨层撞键。
 */
export function useDeeplink(name: string, keys: readonly string[], options: { persistent?: boolean } = {}): DeeplinkGroup {
  const group = ensureStore().group(name, keys, options.persistent === true)
  onScopeDispose(() => group.release())
  return group
}

/**
 * 命令式宿主（模块级 / createApp 挂上去的弹窗）注册分组：没有组件 scope，
 * 调用方必须自己在关闭时 set 空值或 release()。组件里一律用 useDeeplink。
 */
export function deeplinkGroup(name: string, keys: readonly string[]): DeeplinkGroup {
  return ensureStore().group(name, keys, true)
}

/** 当前路由进入时的 URL 原始值（用于「URL 显式给出就忽略本地记忆」的判定） */
export function deeplinkInitial(key: string): string | null {
  return ensureStore().initial(key)
}

/** 路由 path 变化计数（跨路由常驻组件用来重新发布自己的键） */
export function deeplinkRouteEpoch(): Ref<number> {
  return ensureStore().routeEpoch
}

/** 页面异步数据就绪、各层恢复完成：开启 URL 写出（此前只收集，不改地址） */
export function deeplinkHydrate() {
  ensureStore().hydrate()
}

/**
 * 全应用 deeplink 键登记表（Issue #86）：键名全局唯一，新增嵌套 UI 必须在此登记。
 * 约定：父层键在子层打开时保持不变；子层关闭只移除子层键。
 */
export const DEEPLINK_KEYS = {
  /** 首页：搜索词 / 状态筛选 / 排序 / 新建项目弹窗 */
  home: ['q', 'status', 'sort', 'dlg'],
  /** 设置页：主页签 / Agent 子页签 / 选中 Agent */
  settings: ['tab', 'pane', 'agent'],
  /** 设置页弹窗：模型配置、技能、风格、迁移（均只恢复界面，不回填草稿、不自动保存） */
  settingsDialogs: ['cfg', 'skill', 'style', 'migrate', 'sdel'],
  /** 顶栏任务中心抽屉开关（跨路由常驻） */
  taskDrawer: ['tasks'],
  /** 任务中心列表：范围/项目/剧集/类型/状态筛选 + 分页 + 展开行 */
  taskList: ['tscope', 'tdrama', 'tep', 'ttype', 'tstatus', 'tpage', 'texp'],
  /** 任务详情弹窗（任务 id 稳定）+ 审核模式 + 弹窗内部「全屏正文」视图 */
  taskDetail: ['task', 'treview', 'tfull', 'tmodel', 'taskoverwrite', 'tpreview', 'tthink', 'owork', 'ocalls'],
  /** 详情弹窗内部的重试目标、覆盖确认与本地图片预览；父组同时清理孤立的子键。 */
  taskDialogUi: ['tmodel', 'taskoverwrite', 'tpreview', 'tthink'],
  /** 持久公开对话：工作项筛选与展开调用（callId:已载入末消息 id）。 */
  taskConversation: ['owork', 'ocalls'],
  /** 项目详情页：页签 / 素材类型筛选 / 素材编辑弹窗 */
  detail: ['tab', 'filter', 'asset'],
  /** 项目详情页弹窗：图片大图 / 资产浏览器（含其内部筛选）/ 素材库宿主 / 新增剧集 / 项目设置 / 删除确认外壳 */
  detailDialogs: ['view', 'browser', 'bkind', 'bq', 'lib', 'addep', 'proj', 'del', 'mfocus'],
  /** 剧集工作台：面板 / 剧本子步骤 / 制作页签 / 资产子页签 / 提取筛选 / 资产详情弹窗 */
  workbench: ['panel', 'step', 'tab', 'sub', 'extract', 'asset'],
  /** 工作台弹窗层：弹窗 / 大图 / 选中分镜 / 工作区多选 / 弹窗独立批量范围 */
  workbenchDialogs: ['dlg', 'view', 'shot', 'sel', 'bsel', 'mfocus'],
  /** 资产详情弹窗内部：定位的语义条目 / 流水线轮次 */
  assetDetail: ['sem', 'run', 'round'],
  /** 地图几何编辑器：已保存要素的类型与稳定 id；不承载未保存坐标或绘制草稿。 */
  mapGeometry: ['mfocus'],
  /** 地图产出大图：产出身份 base|texture|final|calibration；绝不写图片路径，刷新时按当前详情重新求值。 */
  mapPreview: ['mview'],
  /** 参考图管理器：素材库弹窗的宿主资产（值 = 类型-id，多实例共用一个键） */
  refLibrary: ['reflib'],
  /** 角色档案图面板：检索弹窗与关键词 */
  archival: ['arch', 'archq'],
  /** 设计卡：子阶段 / 选中分镜 / 选择器 / 切换组合弹窗 / 批量范围 */
  design: ['phase', 'shot', 'dpick', 'danchor', 'dcombo', 'dscope'],
  /** 素材/语义选择器内部：类型栏 / 关键词 / 下钻到的素材 */
  picker: ['pktype', 'pkq', 'drill'],
  /** 关键帧步骤：选中分镜 / 批量多选 / 资产池弹窗 */
  keyframes: ['shot', 'sel', 'pool', 'poolkind', 'poolq'],
  /** 分镜制作步骤：选中分镜 / 片段页签 / 弹窗 */
  shotProduction: ['shot', 'seg', 'spdlg'],
  /** 纪录片成片步骤：选中分镜 / 多选 / 预演弹窗 */
  finalPanel: ['shot', 'sel', 'rehearse', 'fdlg'],
  /** 剧本改写：阶段 / 核查弹窗 */
  rewrite: ['rwstage', 'rwdlg'],
  /** Poster：参考图选择器 / 选中版本 */
  poster: ['posterpick', 'posterver', 'pconflict'],
  /** 素材审核清单：筛选 / 忽略与绑定弹窗 */
  assetReview: ['arfilter', 'ardlg'],
  /** 素材库弹窗：左树下钻节点 / 分页 / 预览项（节点编码 <dramaId>:<episodeId|u|->:<kind|->:<ownerId|->:<slot|->） */
  mediaLib: ['libnode', 'libpage', 'libview'],
  /** 图层编辑器：图片选择器开关与来源页签（source|asset|library） */
  layerPicker: ['lpick', 'lpmode'],
  /** 旁白分镜块：单镜配音弹窗 voice=<分镜 id> / 旁白编辑器的多音字检查 nedlg=check:<分镜 id> */
  narration: ['voice', 'nedlg'],
  /** 全局语言切换确认弹窗：目标语言（恢复只开确认框，仍需人工点确认） */
  langSwitch: ['lang'],
  /** 存储迁移阻塞遮罩：仅在迁移真的在进行时才可恢复 */
  migrateOverlay: ['migrating'],
} as const satisfies Record<string, readonly string[]>
