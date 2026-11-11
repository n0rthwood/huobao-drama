/**
 * 模板文本框规范（Issue #96）：`GET /layer-docs/text-spec` 全局只取一次，注入
 * `utils/layerText.js` 的排版引擎（前后端同源，规范数据只有后端那一份）。
 *
 * 规范是模块级数据（引擎的输入），不是每篇文档的字段：组件通过 `version` 知道它已到达并重算
 * 排版与命中框；`ready` 之前画布不画文本框，避免先用空规范排出一堆假框再跳变。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '~/composables/useApi'
import { TEXT_SPEC, layerTextSpecReady, setLayerTextSpec, textLayoutById } from '~/utils/layerText'

export interface TextSpecField {
  key: string
  label: string
  optional?: boolean
  pattern?: string
  pattern_hint?: string
}

export interface TextSpecRole {
  name: string
  category: string
  purpose?: string
  extract?: string
  fields: TextSpecField[]
}

const ready = ref(layerTextSpecReady())
/** 规范版本：0 = 未到达；每成功加载一次 +1，组件的排版派生量靠它重算。 */
const version = ref(ready.value ? 1 : 0)
const error = ref('')
let request: Promise<void> | null = null

/** 幂等加载：并发调用共用同一个请求；失败后允许下次重试（不缓存失败）。 */
export function ensureLayerTextSpec(): Promise<void> {
  if (ready.value) return Promise.resolve()
  if (request) return request
  request = api.get('/layer-docs/text-spec')
    .then((spec: unknown) => {
      if (!setLayerTextSpec(spec)) throw new Error('empty text spec')
      ready.value = true
      error.value = ''
      version.value += 1
    })
    .catch((err: unknown) => {
      error.value = String((err as Error)?.message || err)
      ready.value = false
    })
    .finally(() => { request = null })
  return request
}

export function useLayerTextSpec() {
  void ensureLayerTextSpec()
  return { ready, version, error }
}

/** 规范的角色定义（缺省为空数组/空对象，调用方不必兜底）。 */
export function textRoleDef(role: string): TextSpecRole | undefined {
  return TEXT_SPEC.roles[role] as TextSpecRole | undefined
}

/** 规范里分类是中文名，这里映射成稳定的 i18n 键。 */
const CATEGORY_KEYS: Record<string, string> = {
  标识类: 'identifier',
  叙事类: 'narrative',
  强调类: 'emphasis',
  引语类: 'quote',
  数据类: 'data',
  结构类: 'structure',
  海报类: 'poster',
}

/**
 * 角色 / 字段 / 分类 / 版式套的显示名：先查 i18n，缺键回落到规范里的中文名
 * （规范的名称是唯一事实，本地化只是外层壳）。
 */
export function useLayerTextNames() {
  const { t, te } = useI18n()
  const label = (key: string, fallback: string) => (te(key) ? t(key) : fallback)

  function roleName(role: string) {
    return label(`layerText.role.${role}`, textRoleDef(role)?.name || role)
  }

  function categoryName(category: string) {
    return label(`layerText.category.${CATEGORY_KEYS[category] || category}`, category)
  }

  function fieldLabel(role: string, field: string) {
    const def = textRoleDef(role)?.fields.find(item => item.key === field)
    return label(`layerText.field.${role}.${field}`, def?.label || field)
  }

  function layoutName(id: string) {
    return label(`layerText.layout.${id}`, textLayoutById(id)?.layout.name || id)
  }

  return { roleName, categoryName, fieldLabel, layoutName }
}
