/**
 * 统一语言切换：UI 语言 = AI 内容语言，同一个开关。
 *
 * 两处入口（顶栏 LocaleSwitcher / 设置页通用 tab）都走 confirmUnifiedLanguage：
 * 1. 弹独立确认弹窗（挂 body，说明影响：界面 + AI 内容 + 刷新）
 * 2. 确认后：写后端 content_language → 切 vue-i18n locale → 短暂提示 → location.reload()
 *    （整页重载让所有组件干净重建，避免深嵌组件依赖 watch 的时序问题）
 */
import { createApp, h, ref } from 'vue'
import { i18n, setUiLocale, type UiLocale } from '~/composables/i18n'
import { settingsAPI } from '~/composables/useApi'
import { DEEPLINK_KEYS, deeplinkGroup, deeplinkInitial, queryEnum, type DeeplinkGroup } from '~/composables/useQuerySync'
import LanguageSwitchDialog from '~/components/LanguageSwitchDialog.vue'

let pending: { resolve: (ok: boolean) => void } | null = null

// deeplink（#86）：确认框是全局浮层，复制链接要能把它原样带走。
// 这里是命令式挂载（createApp），没有组件 scope，所以用 deeplinkGroup 并自行摘键。
let langLink: DeeplinkGroup | null = null
function publishLang(lang: UiLocale | '') {
  if (!langLink) langLink = deeplinkGroup('langSwitch', DEEPLINK_KEYS.langSwitch)
  langLink.set({ lang })
}

/** 从链接恢复：只重新弹出确认框（带目标语言），切换仍然必须由用户点确认 */
export function restoreLanguageSwitchDeeplink() {
  const lang = queryEnum(deeplinkInitial('lang'), ['zh', 'en', 'ja', 'ko']) as UiLocale | null
  if (lang) void confirmUnifiedLanguage(lang)
}

/** 弹确认框；resolve(true) = 用户点了确认，resolve(false) = 取消/关闭（绝不写后端） */
function confirmDialog(lang: UiLocale): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const langNameKeys = { zh: 'langNameZh', en: 'langNameEn', ja: 'langNameJa', ko: 'langNameKo' }
  const nameKey = `settings.general.${langNameKeys[lang] || 'langNameZh'}`
  const title = i18n.global.t('components.langSwitch.title', { lang: i18n.global.t(nameKey) })
  const message = i18n.global.t('components.langSwitch.message')

  const open = ref(true)
  const host = document.createElement('div')
  document.body.appendChild(host)
  // 确认与取消各自给出结果：弹窗可由链接恢复，取消路径绝不能当成确认去写内容语言
  const settle = (ok: boolean) => {
    open.value = false
    pending?.resolve(ok)
    pending = null
  }
  const app = createApp({
    setup: () => () => h(LanguageSwitchDialog, {
      open: open.value,
      title,
      message,
      onConfirm: () => settle(true),
      onCancel: () => settle(false),
    }),
  })
  app.use(i18n as unknown as Parameters<typeof app.use>[0])
  app.mount(host)
  publishLang(lang)

  pending = {
    resolve: (ok) => {
      app.unmount()
      host.remove()
      publishLang('')
      resolve(ok)
    },
  }
  return promise
}

let switching = false

/** 入口：先弹确认框，确认后执行统一切换并刷新 */
export async function confirmUnifiedLanguage(lang: UiLocale) {
  if (switching) return
  const ok = await confirmDialog(lang)
  if (!ok) return
  switching = true
  try {
    await settingsAPI.setContentLanguage(lang)
  } catch { /* 后端失败不阻断界面切换 */ }
  setUiLocale(lang)
  try {
    const { toast } = await import('vue-sonner')
    toast.info(i18n.global.t('components.langSwitch.refreshing'), { duration: 1200 })
  } catch { /* 提示失败不阻断 */ }
  setTimeout(() => location.reload(), 1000)
}
