<template>
  <div class="mw" @click.stop>
    <header class="mw-head">
      <strong class="mw-title">{{ t('episode.documentary.map.panel.title') }}</strong>
      <span class="mw-chip">{{ t('episode.documentary.map.stage.' + stage) }}</span>
      <span class="mw-chip" :class="statusClass">{{ t('episode.documentary.map.status.' + status) }}</span>
      <span class="mw-chip dim">{{ t('episode.documentary.map.panel.revision', { n: detail?.revision ?? 0 }) }}</span>
      <div class="mw-mode">
        <button
          v-for="option in MODES"
          :key="option"
          type="button"
          class="mw-tool"
          :class="{ 'is-on': runMode === option }"
          :aria-pressed="runMode === option"
          @click="runMode = option"
        >
          {{ t('episode.documentary.map.panel.mode.' + option) }}
        </button>
      </div>
      <button type="button" class="mw-tool" :disabled="loading" @click="reload">
        <Loader2 v-if="loading" :size="11" class="animate-spin" />
        <RefreshCw v-else :size="11" />
        {{ t('episode.documentary.map.panel.refresh') }}
      </button>
    </header>

    <p class="mw-hint">{{ t('episode.documentary.map.panel.hint') }}</p>

    <p v-if="conflict" class="mw-conflict">
      {{ conflict.message || t('episode.documentary.map.panel.conflictDefault') }}
      <button type="button" class="mw-tool" @click="resolveConflict('keep')">{{ t('episode.documentary.map.panel.conflictKeep') }}</button>
      <button type="button" class="mw-tool" @click="resolveConflict('discard')">{{ t('episode.documentary.map.panel.conflictDiscard') }}</button>
    </p>
    <p v-if="error" class="mw-error">{{ error }}</p>
    <p v-if="detail?.error" class="mw-error">{{ detail.error }}</p>

    <ol v-if="detail" class="mw-rail">
      <li v-for="(step, index) in detail.steps" :key="step.id" class="mw-step" :class="[`is-${step.status}`, { 'is-current': step.id === stage }]">
        <span class="mw-step-index">{{ index + 1 }}</span>
        <span class="mw-step-body">
          <strong>{{ step.label || t('episode.documentary.map.stage.' + step.id) }}</strong>
          <span class="mw-step-status">{{ t('episode.documentary.map.stepStatus.' + step.status) }}</span>
          <span v-if="step.message" class="mw-step-msg">{{ step.message }}</span>
        </span>
        <button
          v-if="step.id !== 'complete' && canRollbackTo(step.id)"
          type="button"
          class="mw-tool"
          :disabled="busy"
          @click="rollback(step.id)"
        >
          {{ t('episode.documentary.map.panel.rollbackTo') }}
        </button>
      </li>
    </ol>

    <section v-if="detail" class="mw-now">
      <div class="mw-now-row">
        <span class="mw-now-label">{{ t('episode.documentary.map.panel.currentWork') }}</span>
        <strong>{{ currentWork }}</strong>
        <span v-if="taskRow" class="mw-task">
          {{ t('episode.documentary.map.panel.task', { id: taskRow.id, status: taskRow.status }) }}
          <span v-if="taskProgress">{{ taskProgress }}</span>
        </span>
      </div>
      <div class="mw-now-row">
        <span class="mw-now-label">{{ t('episode.documentary.map.panel.nextAction') }}</span>
        <span>{{ nextAction }}</span>
      </div>

      <div v-if="blockingIssues.length" class="mw-issues">
        <strong>{{ t('episode.documentary.map.panel.blockedTitle') }}</strong>
        <p v-for="issue in blockingIssues" :key="issue.code + issue.field" class="mw-issue">{{ issue.message }}</p>
      </div>
      <div v-if="softIssues.length" class="mw-issues is-soft">
        <strong>{{ t('episode.documentary.map.panel.noticeTitle') }}</strong>
        <p v-for="issue in softIssues" :key="issue.code + issue.field" class="mw-issue">{{ issue.message }}</p>
      </div>

      <p v-if="draftsDirty" class="mw-warn">{{ t('episode.documentary.map.panel.nextDirty') }}</p>
      <div class="mw-actions">
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !canRun" @click="run">
          <Loader2 v-if="action === 'run'" :size="11" class="animate-spin" />
          <Play v-else :size="11" />
          {{ runLabel }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy || !canAdvance" @click="advance">
          <Loader2 v-if="action === 'advance'" :size="11" class="animate-spin" />
          <StepForward v-else :size="11" />
          {{ advanceLabel }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy || !isRunning" @click="cancel">
          <Loader2 v-if="action === 'cancel'" :size="11" class="animate-spin" />
          <X v-else :size="11" />
          {{ t('episode.documentary.map.panel.cancel') }}
        </button>
        <label class="mw-select">
          <span>{{ t('episode.documentary.map.panel.textConfig') }}</span>
          <select v-model="textConfigId" class="input">
            <option :value="0">{{ t('episode.documentary.map.panel.defaultConfig') }}</option>
            <option v-for="option in textConfigs" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
        </label>
        <label class="mw-select">
          <span>{{ t('episode.documentary.map.panel.imageModel') }}</span>
          <select v-model="imageKey" class="input">
            <option value="">{{ t('episode.documentary.map.panel.defaultConfig') }}</option>
            <option v-for="option in imageOptions" :key="option.key" :value="option.key">{{ option.configName }} · {{ option.model }}</option>
          </select>
        </label>
      </div>
      <p class="mw-hint dim">{{ t('episode.documentary.map.panel.textureHint') }}</p>
    </section>

    <section v-if="detail" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('episode.documentary.map.panel.briefTitle') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.panel.briefHint') }}</span>
        <button type="button" class="mw-tool" :disabled="busy || !briefDirty" @click="saveBrief">
          <Loader2 v-if="action === 'brief'" :size="11" class="animate-spin" />
          {{ t('episode.documentary.map.panel.saveBrief') }}
        </button>
        <button type="button" class="mw-tool" :disabled="busy || !briefDirty" @click="resetBrief">{{ t('episode.documentary.map.panel.discard') }}</button>
      </header>
      <MapBriefForm :brief="briefDraft" :issues="detail.issues" :disabled="busy" @patch="patchBrief" />
    </section>

    <section v-if="detail" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('episode.documentary.map.panel.geometryTitle') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.panel.geometryHint') }}</span>
        <button type="button" class="mw-tool" :disabled="busy || !specDirty" @click="saveSpec">
          <Loader2 v-if="action === 'spec'" :size="11" class="animate-spin" />
          {{ t('episode.documentary.map.panel.saveSpec') }}
        </button>
        <button type="button" class="mw-tool" :disabled="busy || !specDirty" @click="resetSpec">{{ t('episode.documentary.map.panel.discard') }}</button>
      </header>
      <p v-if="specDirty" class="mw-warn">{{ t('episode.documentary.map.panel.specDirtyWarn') }}</p>
      <MapGeoEditor
        :spec="specDraft"
        :registration="registration"
        :base-image="editorBase"
        :disabled="busy"
        @update="specDraft = $event"
        @base-size="editorNatural = $event"
      />
    </section>

    <section v-if="detail" class="mw-block">
      <p v-if="stage !== 'complete'" class="mw-hint dim">{{ t('episode.documentary.map.panel.adoptNote') }}</p>
      <MapResults
        :outputs="detail.outputs"
        :research="detail.research"
        :registration="registration"
        @preview="(url, title) => emit('preview', url, title)"
      />
    </section>

    <section v-if="detail?.history.length" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('episode.documentary.map.panel.historyTitle') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.panel.historyHint') }}</span>
      </header>
      <ul class="mw-history">
        <li v-for="entry in detail.history" :key="`${entry.revision}-${entry.at}`" class="mw-history-row">
          <span class="mw-rev">#{{ entry.revision }}</span>
          <span class="dim">{{ entry.at }}</span>
          <span>{{ t('episode.documentary.map.stage.' + entry.stage) }}</span>
          <span class="dim">{{ entry.action }}</span>
          <span class="mw-actor">{{ t('episode.documentary.map.panel.actor.' + entry.actor) }}</span>
          <span v-if="entry.note" class="dim">{{ entry.note }}</span>
        </li>
      </ul>
    </section>

    <p v-if="!detail && !loading && !error" class="mw-hint dim">{{ t('episode.documentary.map.panel.empty') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图资产工作流面板（Issue #84）。
 *
 * 一个面板承载整条链路：任务说明 → 考证 → 底图 → 风格 → 绘制 → 完成。阶段状态存在服务端，
 * 刷新页面不丢；自动模式一路跑完，手动模式逐阶段推进并在每一步可复核、可回退重做。
 * 几何真值是 map_spec（经纬度），扩散模型只产出纹理，绝不重画地理形状。
 * 任务进度一律从全局任务 store 读，面板自己不轮询。
 */
import { Loader2, Play, RefreshCw, StepForward, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import MapBriefForm from '~/components/MapWorkflow/MapBriefForm.vue'
import MapGeoEditor from '~/components/MapWorkflow/MapGeoEditor.vue'
import MapResults from '~/components/MapWorkflow/MapResults.vue'
import {
  aiConfigAPI,
  mapWorkflowAPI,
  mapWorkflowConflictOf,
  type MapBrief,
  type MapSpec,
  type MapWorkflowDetail,
  type MapWorkflowStage,
} from '~/composables/useApi'
import { onTaskFinished, refreshTasks, useTasks } from '~/composables/useTasks'
import { configModels } from '~/composables/useModelOptions'
import { registrationFrom, registrationFromControlPoints, type MapRegistration } from '~/utils/mapRegistration'

const { t } = useI18n()

const props = defineProps<{
  propId: number
  assetName?: string
}>()

const emit = defineEmits<{
  (e: 'preview', url: string, title: string): void
  (e: 'changed', detail: MapWorkflowDetail): void
}>()

const MODES: Array<'auto' | 'manual'> = ['auto', 'manual']
const STAGE_ORDER: MapWorkflowStage[] = ['brief', 'research', 'base', 'style', 'drawing', 'complete']

const { tasksById } = useTasks()

const detail = ref<MapWorkflowDetail | null>(null)
const loading = ref(false)
const error = ref('')
const action = ref<'' | 'run' | 'advance' | 'cancel' | 'rollback' | 'brief' | 'spec'>('')
const conflict = ref<{ kind: 'revision' | 'busy'; message: string } | null>(null)
const runMode = ref<'auto' | 'manual'>('auto')
const textConfigId = ref(0)
const imageKey = ref('')
const textConfigs = ref<Array<{ id: number; name: string }>>([])
const imageOptions = ref<Array<{ key: string; configId: number; configName: string; model: string }>>([])

const briefDraft = ref<MapBrief>(emptyBrief())
const specDraft = ref<MapSpec>(emptySpec())
// 服务端快照（JSON 串）：dirty 判定与「只提交改过的字段」都以它为基准，必须是响应式的
const serverBrief = ref(JSON.stringify(briefDraft.value))
const serverSpec = ref(JSON.stringify(specDraft.value))
// 画布底图的真实像素尺寸（图片 onload 时由编辑器回传），外部原件尚未经后端出图时用于控制点配准
const editorNatural = ref({ width: 0, height: 0 })

let stopped = false

function emptyBrief(): MapBrief {
  return {
    subject: '',
    era: '',
    location: '',
    purpose: '',
    detail_level: 'regional',
    schematic: false,
    base_mode: 'program',
    style: 'archival',
    notes: '',
    reference_image: null,
    inferred: [],
  }
}

function emptySpec(): MapSpec {
  return {
    version: 1,
    projection: { type: 'mercator' },
    bbox: [100, 20, 130, 45],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
    places: [],
    routes: [],
    regions: [],
    style: { theme: 'archival' },
  }
}

/** 后端可能给 null / 缺字段（刚建的地图资产），补齐后模板不做存在性判断 */
function normalizeSpec(raw: MapSpec | null): MapSpec {
  const base = emptySpec()
  if (!raw) return base
  return {
    version: 1,
    projection: { type: raw.projection?.type === 'equirectangular' ? 'equirectangular' : 'mercator' },
    bbox: Array.isArray(raw.bbox) && raw.bbox.length === 4 ? [...raw.bbox] as MapSpec['bbox'] : base.bbox,
    layers: { ...base.layers, ...(raw.layers ?? {}) },
    places: (raw.places ?? []).map(place => ({ ...place })),
    routes: (raw.routes ?? []).map(route => ({ ...route, points: (route.points ?? []).map(pt => [pt[0], pt[1]] as [number, number]) })),
    regions: (raw.regions ?? []).map(region => ({ ...region, points: (region.points ?? []).map(pt => [pt[0], pt[1]] as [number, number]) })),
    style: { theme: raw.style?.theme === 'clean' ? 'clean' : raw.style?.theme === 'ink' ? 'ink' : 'archival' },
  }
}

const stage = computed(() => detail.value?.stage ?? 'brief')
const status = computed(() => detail.value?.status ?? 'idle')
const isRunning = computed(() => status.value === 'running' || !!detail.value?.busy)
const busy = computed(() => !!action.value || loading.value)
const statusClass = computed(() => `is-${status.value}`)
const briefDirty = computed(() => JSON.stringify(briefDraft.value) !== serverBrief.value)
const specDirty = computed(() => JSON.stringify(specDraft.value) !== serverSpec.value)
const blockingIssues = computed(() => (detail.value?.issues ?? []).filter(issue => issue.blocking))
const softIssues = computed(() => (detail.value?.issues ?? []).filter(issue => !issue.blocking))

const taskRow = computed(() => {
  const id = detail.value?.task_id
  return id ? tasksById.value[id] ?? null : null
})
const taskProgress = computed(() => {
  const progress = taskRow.value?.progress
  if (!progress || !progress.total) return ''
  return t('episode.documentary.map.panel.progress', { done: progress.completed ?? 0, total: progress.total })
})

/**
 * 画布配准：优先用绘制成品的配准（它才是当前这张图的像素口径），否则用底图的。
 * 外部底图在后端出图前，用人工标定的控制点先拟合一个，让人能立刻在真图上画。
 */
const registration = computed<MapRegistration | null>(() => {
  const outputs = detail.value?.outputs
  const fromOutputs = registrationFrom(outputs?.final_image?.provenance, outputs?.base_image?.provenance)
  if (fromOutputs) return fromOutputs
  const reference = briefDraft.value.reference_image
  if (briefDraft.value.base_mode === 'image' && reference && reference.control_points.length >= 3) {
    const base = outputs?.base_image
    return registrationFromControlPoints(
      base?.width || editorNatural.value.width,
      base?.height || editorNatural.value.height,
      reference.control_points,
      { source_url: reference.source_url, license: reference.license },
    )
  }
  return null
})

/**
 * 编辑画布底图：必须是**没有要素**的那张图。
 * 成品 final_image 已经把标注、地名、线面烧进像素，拿它当背景会在可拖拽图层底下留一份改不动的旧几何；
 * 所以优先用绘制阶段单独留的 background（底图 ⊕ 纹理），其次确定性底图，最后外部原件。
 */
const editorBase = computed(() => {
  const outputs = detail.value?.outputs
  const final = outputs?.final_image
  const background = final?.provenance && typeof final.provenance.background === 'string' ? final.provenance.background : ''
  if (background && final) return { path: background, width: final.width, height: final.height }
  const base = outputs?.base_image
  if (base?.path) return { path: base.path, width: base.width, height: base.height }
  const reference = briefDraft.value.reference_image
  if (reference?.path) return { path: reference.path, width: 0, height: 0 }
  return null
})

/** 待复核时 detail.stage 已经是「下一个要跑的阶段」，被复核的是它前面那一步 */
const reviewedStage = computed<MapWorkflowStage | null>(() => {
  const index = STAGE_ORDER.indexOf(stage.value)
  return index > 0 ? STAGE_ORDER[index - 1] : null
})

const currentWork = computed(() => {
  if (!detail.value) return ''
  const label = t('episode.documentary.map.stage.' + stage.value)
  if (isRunning.value) return t('episode.documentary.map.panel.workRunning', { stage: label })
  if (status.value === 'awaiting_review') {
    const reviewed = reviewedStage.value
    return t('episode.documentary.map.panel.workReview', { stage: reviewed ? t('episode.documentary.map.stage.' + reviewed) : label })
  }
  if (status.value === 'blocked') return t('episode.documentary.map.panel.workBlocked', { stage: label })
  if (status.value === 'failed') return t('episode.documentary.map.panel.workFailed', { stage: label })
  if (status.value === 'completed' || stage.value === 'complete') return t('episode.documentary.map.panel.workDone')
  return t('episode.documentary.map.panel.workIdle', { stage: label })
})

/** 下一步要跑的阶段就是 detail.stage 本身（后端在每一步结束时已经推进过了） */
const nextStage = computed<MapWorkflowStage | null>(() => (stage.value === 'complete' ? null : stage.value))

const nextAction = computed(() => {
  if (!detail.value) return ''
  if (isRunning.value) return t('episode.documentary.map.panel.nextRunning')
  // 草稿没保存就启动，跑的是服务端的旧值：先说清楚要先保存或放弃
  if (draftsDirty.value) return t('episode.documentary.map.panel.nextDirty')
  if (status.value === 'blocked') {
    const first = blockingIssues.value[0]
    return first ? t('episode.documentary.map.panel.nextBlocked', { reason: first.message }) : t('episode.documentary.map.panel.nextBlockedGeneric')
  }
  if (status.value === 'failed') return t('episode.documentary.map.panel.nextFailed', { stage: t('episode.documentary.map.stage.' + stage.value) })
  if (status.value === 'awaiting_review') {
    const next = nextStage.value
    return next
      ? t('episode.documentary.map.panel.nextReview', { stage: t('episode.documentary.map.stage.' + next) })
      : t('episode.documentary.map.panel.nextReviewLast')
  }
  if (stage.value === 'complete' || status.value === 'completed') return t('episode.documentary.map.panel.nextDone')
  return runMode.value === 'auto'
    ? t('episode.documentary.map.panel.nextAuto')
    : t('episode.documentary.map.panel.nextManual', { stage: t('episode.documentary.map.stage.' + stage.value) })
})

const draftsDirty = computed(() => briefDirty.value || specDirty.value)
const canRun = computed(() => !!detail.value && !isRunning.value && !draftsDirty.value && !blockingIssues.value.length && stage.value !== 'complete')
const canAdvance = computed(() => canRun.value)
const runLabel = computed(() => (runMode.value === 'auto'
  ? t('episode.documentary.map.panel.runAuto')
  : t('episode.documentary.map.panel.runManual')))
const advanceLabel = computed(() => (status.value === 'awaiting_review'
  ? t('episode.documentary.map.panel.approveNext')
  : t('episode.documentary.map.panel.advance')))

function canRollbackTo(target: MapWorkflowStage): boolean {
  if (!detail.value || isRunning.value) return false
  const current = STAGE_ORDER.indexOf(stage.value)
  const index = STAGE_ORDER.indexOf(target)
  return index >= 0 && index <= current
}

/**
 * 写回服务端快照。
 * 刚保存成功时只采用所保存部分的服务端版本；保存说明不能清掉另一份尚未保存的几何草稿，反之亦然。
 * 其余情况（任务刷新、冲突后回读）只在本地没有改动时才跟随服务端——有改动就一个字都不动，
 * 由人按「保存」或「放弃修改」决定，后台刷新绝不能吞掉正在编辑的内容。
 */
function applyDetail(next: MapWorkflowDetail, adopt?: 'brief' | 'spec') {
  detail.value = next
  const nextBrief = JSON.stringify({ ...emptyBrief(), ...next.brief })
  if (adopt === 'brief' || !briefDirty.value) briefDraft.value = JSON.parse(nextBrief) as MapBrief
  serverBrief.value = nextBrief
  const nextSpec = JSON.stringify(normalizeSpec(next.map_spec))
  if (adopt === 'spec' || !specDirty.value) specDraft.value = JSON.parse(nextSpec) as MapSpec
  serverSpec.value = nextSpec
  emit('changed', next)
}

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const res = await mapWorkflowAPI.get(props.propId)
    if (stopped) return
    error.value = ''
    applyDetail(res)
  } catch (err) {
    if (!stopped) error.value = err instanceof Error && err.message ? err.message : t('episode.documentary.map.panel.loadFailed')
  } finally {
    if (!stopped) loading.value = false
  }
}

function reload() {
  void load()
}

/** 409 冲突：服务端状态没变，本地草稿一律保留，由人决定是重新基于最新修订保存还是放弃 */
function handleError(err: unknown, fallback: string) {
  const detected = mapWorkflowConflictOf(err)
  if (detected) {
    conflict.value = { kind: detected.kind, message: detected.message }
    void load(true)
    return
  }
  error.value = err instanceof Error && err.message ? err.message : fallback
  toast.error(error.value)
}

function resolveConflict(choice: 'keep' | 'discard') {
  conflict.value = null
  if (choice === 'discard') {
    resetBrief()
    resetSpec()
  }
  void load(true)
}

function selectedImage() {
  return imageOptions.value.find(option => option.key === imageKey.value) ?? null
}

function runOptions() {
  const image = selectedImage()
  return {
    text_config_id: textConfigId.value || undefined,
    image_config_id: image?.configId,
    image_model: image?.model,
    expected_revision: detail.value?.revision,
  }
}

async function run() {
  if (busy.value || !canRun.value) return
  action.value = 'run'
  error.value = ''
  try {
    const res = await mapWorkflowAPI.run(props.propId, { mode: runMode.value, ...runOptions() })
    if (stopped) return
    applyDetail(res)
    await refreshTasks()
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.runFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function advance() {
  if (busy.value || !canAdvance.value) return
  action.value = 'advance'
  error.value = ''
  try {
    const res = await mapWorkflowAPI.advance(props.propId, runOptions())
    if (stopped) return
    applyDetail(res)
    await refreshTasks()
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.advanceFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function cancel() {
  if (busy.value) return
  action.value = 'cancel'
  try {
    const res = await mapWorkflowAPI.cancel(props.propId)
    if (stopped) return
    applyDetail(res)
    await refreshTasks()
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.cancelFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function rollback(target: MapWorkflowStage) {
  if (busy.value) return
  action.value = 'rollback'
  try {
    const res = await mapWorkflowAPI.rollback(props.propId, target, detail.value?.revision)
    if (stopped) return
    applyDetail(res)
    toast.success(t('episode.documentary.map.panel.rolledBack', { stage: t('episode.documentary.map.stage.' + target) }))
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.rollbackFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

function patchBrief(patch: Partial<MapBrief>) {
  briefDraft.value = { ...briefDraft.value, ...patch }
}

/** 只提交改过的字段：brief 在服务端按字段合并，整份回传会把 AI 推断的其他字段也当成人工改动 */
function briefPatch(): Partial<MapBrief> {
  const server = JSON.parse(serverBrief.value) as MapBrief
  const patch: Partial<MapBrief> = {}
  for (const key of Object.keys(briefDraft.value) as Array<keyof MapBrief>) {
    if (key === 'inferred') continue
    if (JSON.stringify(briefDraft.value[key]) !== JSON.stringify(server[key])) {
      Object.assign(patch, { [key]: briefDraft.value[key] })
    }
  }
  return patch
}

async function saveBrief() {
  if (busy.value || !briefDirty.value) return
  action.value = 'brief'
  error.value = ''
  try {
    const res = await mapWorkflowAPI.save(props.propId, { expected_revision: detail.value?.revision, brief: briefPatch() })
    if (stopped) return
    applyDetail(res, 'brief')
    conflict.value = null
    toast.success(t('episode.documentary.map.panel.briefSaved'))
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function saveSpec() {
  if (busy.value || !specDirty.value) return
  action.value = 'spec'
  error.value = ''
  try {
    const res = await mapWorkflowAPI.save(props.propId, { expected_revision: detail.value?.revision, map_spec: specDraft.value })
    if (stopped) return
    applyDetail(res, 'spec')
    conflict.value = null
    toast.success(t('episode.documentary.map.panel.specSaved'))
  } catch (err) {
    if (!stopped) handleError(err, t('episode.documentary.map.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

function resetBrief() {
  briefDraft.value = JSON.parse(serverBrief.value) as MapBrief
}

function resetSpec() {
  specDraft.value = JSON.parse(serverSpec.value) as MapSpec
}

async function loadConfigs() {
  try {
    const [textRaw, imageRaw] = await Promise.all([aiConfigAPI.list('text'), aiConfigAPI.list('image')])
    if (stopped) return
    const texts: Array<{ id: number; name: string }> = []
    for (const row of (Array.isArray(textRaw) ? textRaw : []) as Array<Record<string, unknown>>) {
      const id = Number(row.id)
      if (!Number.isFinite(id) || !(row.is_active ?? row.isActive)) continue
      texts.push({ id, name: typeof row.name === 'string' && row.name ? row.name : String(id) })
    }
    textConfigs.value = texts
    const images: Array<{ key: string; configId: number; configName: string; model: string }> = []
    for (const row of (Array.isArray(imageRaw) ? imageRaw : []) as Array<Record<string, unknown>>) {
      const id = Number(row.id)
      if (!Number.isFinite(id) || !(row.is_active ?? row.isActive)) continue
      const name = typeof row.name === 'string' && row.name ? row.name : String(id)
      const models = configModels(row.model)
      for (const model of models) images.push({ key: `${id}:${model}`, configId: id, configName: name, model })
    }
    imageOptions.value = images
  } catch {
    if (!stopped) {
      textConfigs.value = []
      imageOptions.value = []
    }
  }
}

// 任务状态变化就刷新阶段状态：面板自己不轮询，统一吃全局任务 store 的快照
watch(() => taskRow.value?.status, (next, prev) => {
  if (next && next !== prev) void load(true)
})

onTaskFinished((task) => {
  if (detail.value && Number(task.id) === Number(detail.value.task_id)) void load(true)
})

watch(() => props.propId, () => {
  detail.value = null
  briefDraft.value = emptyBrief()
  specDraft.value = emptySpec()
  serverBrief.value = JSON.stringify(briefDraft.value)
  serverSpec.value = JSON.stringify(specDraft.value)
  conflict.value = null
  void load()
})

watch(() => detail.value?.mode, (mode) => {
  if (mode) runMode.value = mode
})

onMounted(() => {
  void load()
  void loadConfigs()
})

onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.mw {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 工作台最小工作宽度 1280：窄于此整页横向滚动（与 Issue #20 的页面口径一致） */
  min-width: 0;
}
.mw-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.mw-title { font: 600 12.5px var(--font-body); color: var(--text-1); }
.mw-mode { display: inline-flex; gap: 4px; margin-left: auto; }
.mw-chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10.5px var(--font-body);
  color: var(--text-2);
}
.mw-chip.is-running { color: var(--accent-text); border-color: var(--accent-text); }
.mw-chip.is-blocked,
.mw-chip.is-failed { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.mw-chip.is-completed { color: var(--accent-text); }
.mw-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.mw-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.mw-tool.is-on { color: var(--accent-text); border-color: var(--accent-text); }
.mw-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.mw-hint { margin: 0; font-size: 10.5px; color: var(--text-2); }
.mw-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.mw-warn,
.mw-conflict {
  margin: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.mw-rail {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 6px;
}
.mw-step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  font-size: 10.5px;
  color: var(--text-2);
}
.mw-step.is-current { border-color: var(--accent-text); }
.mw-step.is-failed { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.mw-step-index {
  flex: none;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  font: 600 9.5px var(--font-body);
}
.mw-step-body { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.mw-step-body strong { font: 600 11px var(--font-body); color: var(--text-1); }
.mw-step-status { font-size: 10px; }
.mw-step-msg { font-size: 10px; word-break: break-word; }
.mw-now {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.mw-now-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--text-2); }
.mw-now-label { font: 600 11px var(--font-body); color: var(--text-1); }
.mw-task { margin-left: auto; font-size: 10.5px; color: var(--text-2); }
.mw-issues { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 6px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); font-size: 10.5px; }
.mw-issues.is-soft { background: transparent; border-color: var(--border); color: var(--text-2); }
.mw-issue { margin: 0; }
.mw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.mw-select { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-2); }
.mw-select .input { width: 190px; }
.mw-block { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px dashed var(--border); }
.mw-block-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.mw-history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.mw-history-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--text-2);
}
.mw-rev { font-weight: 600; color: var(--text-1); }
.mw-actor { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-strong); font-weight: 600; }
</style>
