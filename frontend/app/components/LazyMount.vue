<script setup>
/**
 * 视口懒挂载（Issue #106）：槽内容进入视口上下约 1 屏时才挂载；离开约 2 屏后申请卸载。
 *
 * 卸载必须由槽内容明确放行（`canUnload()` 返回 true）：正在编辑、保存中/失败、媒体播放中、
 * 弹窗打开、有请求在飞的镜卡一律保持挂载，等下一次视口观察或轮询复查（保存完成、焦点离开、
 * 播放结束）后再卸。卸载前记录真实高度，占位保持同高，避免滚动跳动；从未挂载过的占位用
 * 父级按组合给的估计高度，避免一次命中几十个占位形成挂载风暴。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  // deeplink 目标：强制挂载，永不申请卸载
  force: { type: Boolean, default: false },
  // 卸载许可：父级从槽内容的 defineExpose().canUnload 转发；缺省视为允许
  canUnload: { type: Function, default: null },
  // 从未挂载过的占位最小高度（px）：按组合估计（约 2–3 张卡/屏）
  estimate: { type: Number, default: 600 },
  // 占位文案（镜号与段组合）
  label: { type: String, default: '' },
})
const emit = defineEmits(['measured'])

/** 进入视口上下约 1 屏就挂载：滚动到附近时不再等进入首屏 */
const MOUNT_MARGIN = '100% 0px'
/** 离开约 2 屏才申请卸载 */
const UNLOAD_MARGIN = '200% 0px'
/** 拒绝卸载后的复查间隔：保存完成 / 焦点离开 / 播放结束都在这个粒度内恢复卸载 */
const RECHECK_MS = 700

const root = ref(null)
const mounted = ref(props.force)
const recordedHeight = ref(0)
const placeholderHeight = computed(() => recordedHeight.value || props.estimate)

let mountObserver = null
let unloadObserver = null
let recheckTimer = null
/** 是否在卸载区（约 2 屏外）：只有在这里才复查卸载许可 */
let outOfZone = false

/** 最近的滚动容器：优先用它当观察根，rootMargin 才能按容器高度算上下 1/2 屏 */
function scrollRootOf(el) {
  let node = el?.parentElement || null
  while (node && node !== document.documentElement) {
    const overflow = window.getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node
    node = node.parentElement
  }
  return null
}

function canUnloadNow() {
  if (props.force) return false
  if (!props.canUnload) return true
  try {
    return props.canUnload() !== false
  } catch {
    return false
  }
}

function mountNow() {
  mounted.value = true
  stopRecheck()
}

function stopRecheck() {
  if (!recheckTimer) return
  clearInterval(recheckTimer)
  recheckTimer = null
}

function startRecheck() {
  if (recheckTimer) return
  recheckTimer = setInterval(() => {
    if (!mounted.value || !outOfZone) {
      stopRecheck()
      return
    }
    requestUnload()
  }, RECHECK_MS)
}

function requestUnload() {
  if (!mounted.value || props.force) return
  if (!canUnloadNow()) {
    startRecheck()
    return
  }
  stopRecheck()
  const height = Math.round(root.value?.offsetHeight || 0)
  if (height > 0) {
    recordedHeight.value = height
    emit('measured', height)
  }
  mounted.value = false
}

onMounted(() => {
  const el = root.value
  if (!el) return
  const rootEl = scrollRootOf(el)
  mountObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) mountNow()
  }, { root: rootEl, rootMargin: MOUNT_MARGIN })
  unloadObserver = new IntersectionObserver(entries => {
    const entry = entries[entries.length - 1]
    outOfZone = !entry?.isIntersecting
    if (outOfZone) requestUnload()
    else stopRecheck()
  }, { root: rootEl, rootMargin: UNLOAD_MARGIN })
  mountObserver.observe(el)
  unloadObserver.observe(el)
})

// deeplink 目标可能在挂载后才知道（强制挂载立即生效）；取消强制后回到正常卸载规则
watch(() => props.force, force => {
  if (force) {
    mountNow()
    return
  }
  if (outOfZone) requestUnload()
})

onBeforeUnmount(() => {
  mountObserver?.disconnect()
  unloadObserver?.disconnect()
  mountObserver = null
  unloadObserver = null
  stopRecheck()
})
</script>

<template>
  <div ref="root" :style="mounted ? undefined : { minHeight: `${placeholderHeight}px` }">
    <template v-if="mounted"><slot /></template>
    <div v-else class="lazy-placeholder">{{ label }}</div>
  </div>
</template>

<style scoped>
.lazy-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与父级记录的真实高度同高：占位不能改变滚动长度 */
  min-height: inherit;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-1);
  color: var(--text-3);
  font-size: 12px;
  padding: 12px;
}
</style>
