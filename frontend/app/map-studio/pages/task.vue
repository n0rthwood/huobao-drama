<template>
  <div class="mw ms-harness" @click.stop>
    <NuxtLink to="/map-studio">{{ t('mapStudio.app.title') }}</NuxtLink>
    <MapHostHeader v-if="detail" :task-id="taskId" :title="detail.title" :host="detail.host" />
    <header class="mw-head">
      <strong class="mw-title">{{ t('mapStudio.panel.title') }}</strong>
      <span class="mw-chip">{{ t('mapStudio.stage.' + stage) }}</span>
      <span class="mw-chip" :class="statusClass">{{ t('mapStudio.status.' + status) }}</span>
      <span class="mw-chip dim">{{ t('mapStudio.panel.revision', { n: detail?.revision ?? 0 }) }}</span>
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
          {{ t('mapStudio.panel.mode.' + option) }}
        </button>
      </div>
      <button type="button" class="mw-tool" :disabled="loading" @click="reload">
        <Loader2 v-if="loading" :size="11" class="animate-spin" />
        <RefreshCw v-else :size="11" />
        {{ t('mapStudio.panel.refresh') }}
      </button>
    </header>

    <p class="mw-hint">{{ t('mapStudio.panel.hint') }}</p>

    <p v-if="conflict" class="mw-conflict">
      {{ conflict.message || t('mapStudio.panel.conflictDefault') }}
      <button type="button" class="mw-tool" @click="resolveConflict('keep')">{{ t('mapStudio.panel.conflictKeep') }}</button>
      <button type="button" class="mw-tool" @click="resolveConflict('discard')">{{ t('mapStudio.panel.conflictDiscard') }}</button>
    </p>
    <p v-if="error" class="mw-error">{{ error }}</p>
    <p v-if="detail?.error" class="mw-error">{{ detail.error }}</p>

    <ol v-if="detail" class="mw-rail">
      <li v-for="(step, index) in detail.steps" :key="step.id" class="mw-step" :class="[`is-${step.status}`, { 'is-current': step.id === stage }]">
        <span class="mw-step-index">{{ index + 1 }}</span>
        <span class="mw-step-body">
          <button type="button" class="mw-tool" :aria-pressed="selectedStage === step.id" @click="navigationTouched = true; selectedStage = step.id">{{ t('mapStudio.stage.' + step.id) }}</button>
          <span class="mw-step-status">{{ t('mapStudio.stepStatus.' + step.status) }}</span>
          <span v-if="step.message" class="mw-step-msg">{{ step.message }}</span>
        </span>
        <button
          v-if="step.id !== 'complete' && canRollbackTo(step.id)"
          type="button"
          class="mw-tool"
          :disabled="busy"
          @click="rollback(step.id)"
        >
          {{ t('mapStudio.panel.rollbackTo') }}
        </button>
      </li>
    </ol>

    <MapStagePanel v-if="detail" :detail="detail" :stage="selectedStage" :confirming="action === 'confirm'" @preview="openPreview" @confirm="confirmGeometry" />
    <MapAgentProcess v-if="detail && runsLoaded" :task-id="taskId" :stage="selectedStage" :runs="runs" :selected-run-id="selectedRunId" :loading-runs="false" :now="nowMs" @select-run="navigationTouched = true; selectedRunId = $event" @reload-runs="loadRuns" />
    <MapDeliveries v-if="detail" :task-id="taskId" :deliveries="detail.deliveries" :outputs="detail.outputs" :can-deliver="!!detail.host && !hostMissing && !isRunning && !!detail.outputs.final_image" :busy="busy || delivering" :delivering="delivering" error="" @deliver="redeliver" />
    <section v-if="detail" class="mw-now">
      <div class="mw-now-row">
        <span class="mw-now-label">{{ t('mapStudio.panel.currentWork') }}</span>
        <strong>{{ currentWork }}</strong>
      </div>
      <div class="mw-now-row">
        <span class="mw-now-label">{{ t('mapStudio.panel.nextAction') }}</span>
        <span>{{ nextAction }}</span>
      </div>

      <div v-if="blockingIssues.length" class="mw-issues">
        <strong>{{ t('mapStudio.panel.blockedTitle') }}</strong>
        <p v-for="issue in blockingIssues" :key="issue.code + issue.field" class="mw-issue">{{ issue.message }}</p>
      </div>
      <div v-if="softIssues.length" class="mw-issues is-soft">
        <strong>{{ t('mapStudio.panel.noticeTitle') }}</strong>
        <p v-for="issue in softIssues" :key="issue.code + issue.field" class="mw-issue">{{ issue.message }}</p>
      </div>

      <!-- 当前/失败阶段的最新一轮被拒原因：卡在哪条校验上要和步骤状态一起看见，不用展开 -->
      <div v-if="latestRejection" class="mw-issues">
        <strong>
          {{ t('mapStudio.agent.latestRejection', {
            n: latestRejection.round,
            stage: t('mapStudio.stage.' + latestRejection.stage),
          }) }}
        </strong>
        <p v-for="(reason, index) in latestRejection.problems" :key="index" class="mw-issue">{{ reason }}</p>
        <p v-if="!latestRejection.problems.length" class="mw-issue">{{ t('mapStudio.agent.outcome.' + latestRejection.outcome) }}</p>
        <button type="button" class="mw-tool" @click="openAttempts(latestRejection.stage)">{{ t('mapStudio.agent.viewAttempts') }}</button>
      </div>

      <p v-if="draftsDirty" class="mw-warn">{{ t('mapStudio.panel.nextDirty') }}</p>
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
          {{ t('mapStudio.panel.cancel') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="!canEditLayers" @click="openLayerEditor">
          <PenLine :size="11" />
          {{ t('mapStudio.layerEditor.open') }}
        </button>
        <label class="mw-select">
          <span>{{ t('mapStudio.panel.textConfig') }}</span>
          <select v-model="textConfigId" class="input">
            <option :value="0">{{ t('mapStudio.panel.defaultConfig') }}</option>
            <option v-for="option in textConfigs" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
        </label>
        <label class="mw-select">
          <span>{{ t('mapStudio.panel.imageModel') }}</span>
          <select v-model="imageKey" class="input">
            <option value="">{{ t('mapStudio.panel.defaultConfig') }}</option>
            <option v-for="option in imageOptions" :key="option.key" :value="option.key">{{ option.configName }} · {{ option.model }}</option>
          </select>
        </label>
      </div>
      <p class="mw-hint dim">{{ t('mapStudio.panel.textureHint') }}</p>
    </section>

    <section v-if="detail" class="mw-block">
      <MapAgentRounds
        :agent="agentState"
        :stage="stage"
        :open-stage="openAttemptStage"
        :now="nowMs"
        @open="setAttemptStage"
      />
    </section>

    <section v-if="detail" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('mapStudio.panel.briefTitle') }}</strong>
        <span class="dim">{{ t('mapStudio.panel.briefHint') }}</span>
        <button type="button" class="mw-tool" :disabled="busy || !briefDirty" @click="saveBrief">
          <Loader2 v-if="action === 'brief'" :size="11" class="animate-spin" />
          {{ t('mapStudio.panel.saveBrief') }}
        </button>
        <button type="button" class="mw-tool" :disabled="busy || !briefDirty" @click="resetBrief">{{ t('mapStudio.panel.discard') }}</button>
      </header>
      <MapBriefForm :brief="briefDraft" :issues="detail.issues" :disabled="busy" @patch="patchBrief" />
    </section>

    <section v-if="detail" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('mapStudio.panel.geometryTitle') }}</strong>
        <span class="dim">{{ t('mapStudio.panel.geometryHint') }}</span>
        <button type="button" class="mw-tool" :disabled="busy || !geometryDirty" @click="saveSpec">
          <Loader2 v-if="action === 'spec'" :size="11" class="animate-spin" />
          {{ t('mapStudio.panel.saveSpec') }}
        </button>
        <button type="button" class="mw-tool" :disabled="busy || !geometryDirty" @click="resetSpec">{{ t('mapStudio.panel.discard') }}</button>
      </header>
      <p v-if="geometryDirty" class="mw-warn">{{ t('mapStudio.panel.specDirtyWarn') }}</p>
      <MapGeoEditor
        :spec="specDraft"
        :persisted-spec="detail.map_spec"
        :registration="registration"
        :base-image="editorBase"
        :layer-doc="editorDoc"
        :layer-options="layerOptionsDraft"
        :disabled="busy"
        @update="specDraft = $event"
        @layer-options="layerOptionsDraft = $event"
        @base-size="editorNatural = $event"
      />
    </section>

    <section v-if="detail" class="mw-block">
      <p v-if="previewWarning" class="mw-warn">{{ previewWarning }}</p>
      <p v-if="detail.host && stage !== 'complete'" class="mw-hint dim">{{ t('mapStudio.panel.adoptNote') }}</p>
      <MapResults
        :outputs="detail.outputs"
        :research="detail.research"
        :registration="registration"
        @preview="openPreview"
      />
    </section>

    <section v-if="detail?.history.length" class="mw-block">
      <header class="mw-block-head">
        <strong>{{ t('mapStudio.panel.historyTitle') }}</strong>
        <span class="dim">{{ t('mapStudio.panel.historyHint') }}</span>
      </header>
      <ul class="mw-history">
        <li v-for="entry in detail.history" :key="`${entry.revision}-${entry.at}`" class="mw-history-row">
          <span class="mw-rev">#{{ entry.revision }}</span>
          <span class="dim">{{ entry.at }}</span>
          <span>{{ t('mapStudio.stage.' + entry.stage) }}</span>
          <span class="dim">{{ entry.action }}</span>
          <span class="mw-actor">{{ t('mapStudio.panel.actor.' + entry.actor) }}</span>
          <span v-if="entry.note" class="dim">{{ entry.note }}</span>
        </li>
      </ul>
    </section>

    <p v-if="!detail && !loading && !error" class="mw-hint dim">{{ t('mapStudio.panel.empty') }}</p>

    <!-- 产出大图：本面板自己的层，teleport 到 body 才能稳定盖在宿主弹窗之上；关闭只清 msview、保留 asset/mfocus -->
    <Teleport to="body">
      <div v-if="previewImage" class="mw-preview-overlay" @click.self="closePreview">
        <div class="mw-preview-dialog">
          <div class="mw-preview-head">
            <span class="mw-preview-title">{{ previewTitle }}</span>
            <button type="button" class="mw-tool" @click="closePreview">
              <X :size="12" />
              {{ t('mapStudio.preview.close') }}
            </button>
          </div>
          <img :src="previewImage.url" :alt="previewTitle" class="mw-preview-img" />
          <p class="mw-preview-meta dim">{{ t('mapStudio.results.size', { w: previewImage.width, h: previewImage.height }) }} · {{ t('mapStudio.results.source', { source: previewImage.source }) }}</p>
        </div>
      </div>
    </Teleport>

    <!-- 图层编辑器：同样 teleport 到 body；关闭只清 mslayer，宿主的 asset / mfocus 原样保留 -->
    <Teleport to="body">
      <MapLayerEditor
        v-if="editorOpen && editorDoc && detail"
        :task-id="taskId"
        :layer-doc="editorDoc"
        :layer-options="layerOptionsDraft"
        :revision="detail.revision"
        :asset-name="detail.title"
        @close="closeLayerEditor"
        @saved="onLayerDocSaved"
        @conflict="reloadQuiet"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图资产工作流面板（Issue #84）。
 *
 * 一个面板承载整条链路：任务说明 → 考证 → 底图 → 风格 → 绘制 → 完成。阶段状态存在服务端，
 * 刷新页面不丢；自动模式一路跑完，手动模式逐阶段推进并在每一步可复核、可回退重做。
 * 几何真值是 map_spec（经纬度），扩散模型只产出纹理，绝不重画地理形状。
 * 运行状态由模块 API 持久化；执行中每三秒刷新，终态停止服务端轮询。
 */
import MapHostHeader from '~/map-studio/components/MapHostHeader.vue'
import MapStagePanel from '~/map-studio/components/MapStagePanel.vue'
import MapAgentProcess from '~/map-studio/components/MapAgentProcess.vue'
import MapDeliveries from '~/map-studio/components/MapDeliveries.vue'
import type { MapStudioRun, MapStudioModelOptions } from '~/map-studio/api'
import { Loader2, PenLine, Play, RefreshCw, StepForward, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import MapBriefForm from '~/map-studio/components/MapBriefForm.vue'
import MapGeoEditor from '~/map-studio/components/MapGeoEditor.vue'
import MapResults from '~/map-studio/components/MapResults.vue'
import MapAgentRounds from '~/map-studio/components/MapAgentRounds.vue'
import MapLayerEditor from '~/map-studio/components/MapLayerEditor.vue'
import {
  confirmSpecFeatures,
  mapStudioAPI,
  mapStudioConflictOf,
  type MapAgentAttempt,
  type MapAgentState,
  type MapBrief,
  type MapConfirmTarget,
  type MapLayerSmoothing,
  type MapSpec,
  type MapStudioDetail,
  type MapStudioStage,
} from '~/map-studio/api'
import { registrationFrom, registrationFromControlPoints, type MapRegistration } from '~/map-studio/utils/mapRegistration'
import { mapPreviewImage, mapPreviewView, type MapPreviewView } from '~/map-studio/utils/mapPreview'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
definePageMeta({ key: route => route.path })
const taskId = computed(() => Number(route.params.taskId))
const runs = ref<MapStudioRun[]>([])
const runsLoaded = ref(false)
const selectedRunId = ref<number | null>(null)
const selectedStage = ref<MapStudioStage>('brief')
const runLink = useDeeplink('mapStudioRun', DEEPLINK_KEYS.mapStudioRun)
let restored = false
let navigationTouched = false
const hostMissing = computed(() => !!detail.value?.host && !detail.value.host.target)
const modelOptions = ref<MapStudioModelOptions>({ text: [], image: [] })
async function loadRuns() {
  const res = await mapStudioAPI.runs(taskId.value)
  runs.value = res.runs
  runsLoaded.value = true
  if (!restored && !navigationTouched) {
    const rawStage = runLink.initial('msstage')
    if (rawStage && !STAGE_ORDER.includes(rawStage as MapStudioStage)) toast.warning(t('deeplink.missing'))
    selectedStage.value = STAGE_ORDER.includes(rawStage as MapStudioStage) ? rawStage as MapStudioStage : stage.value
    const rawRun = Number(runLink.initial('msrun'))
    if (rawRun && !res.runs.some(run => run.id === rawRun)) toast.warning(t('deeplink.missing'))
    selectedRunId.value = rawRun ? (res.runs.some(run => run.id === rawRun) ? rawRun : null) : res.runs[0]?.id ?? null
    restored = true
  }
}
watch([selectedStage, selectedRunId], () => runLink.set({ msstage: selectedStage.value, msrun: selectedRunId.value }))
const delivering = ref(false)
async function redeliver() {
  if (delivering.value) return
  delivering.value = true
  try { await mapStudioAPI.deliver(taskId.value); await load(true) }
  catch (err) { handleError(err, t('mapStudio.panel.saveFailed')) }
  finally { delivering.value = false }
}
const MODES: Array<'auto' | 'manual'> = ['auto', 'manual']
const STAGE_ORDER: MapStudioStage[] = ['brief', 'research', 'base', 'style', 'drawing', 'complete']


const detail = ref<MapStudioDetail | null>(null)
const loading = ref(false)
const error = ref('')
const action = ref<'' | 'run' | 'advance' | 'cancel' | 'rollback' | 'brief' | 'spec' | 'confirm'>('')
const conflict = ref<{ kind: 'revision' | 'busy'; message: string } | null>(null)
const runMode = ref<'auto' | 'manual'>('auto')
const textConfigId = ref(0)
const imageKey = ref('')
const textConfigs = ref<Array<{ id: number; name: string }>>([])
const imageOptions = ref<Array<{ key: string; configId: number; configName: string; model: string }>>([])

/**
 * 模型轮次与图层编辑器（Issue #90）：本面板自己的 deeplink 组 mapAgent。
 * mslayer=1 只开编辑器界面（恢复绝不触发保存/重绘），msround 记住展开的阶段；
 * 目标不存在时清掉自己的键并给可读提示，不停在空壳上。
 */
const agentLink = useDeeplink('mapAgent', DEEPLINK_KEYS.mapStudioAgent)
const editorOpen = ref(false)
const openAttemptStage = ref('')
const nowMs = ref(Date.now())
let agentRestored = false
let clockTimer: ReturnType<typeof setInterval> | null = null

/**
 * 产出大图预览（Issue #84 / #86）：本面板自己的 deeplink 键 msview。
 * 只记产出身份（base|texture|final|calibration），URL 里绝不出现图片路径；刷新/新标签按当前详情重新求值。
 * 关闭只清自己的键，宿主的 asset / mfocus 原样保留。
 */
const previewLink = useDeeplink('mapPreview', DEEPLINK_KEYS.mapStudioPreview)
const previewView = ref<MapPreviewView | null>(null)
const previewWarning = ref('')
let previewRestored = false

const briefDraft = ref<MapBrief>(emptyBrief())
const specDraft = ref<MapSpec>(emptySpec())
/** 阶段 ③：线面平滑参数草稿；与 map_spec 同一次 CAS 提交，服务端快照是 dirty 判定基准 */
const layerOptionsDraft = ref<MapLayerSmoothing>({})
// 服务端快照（JSON 串）：dirty 判定与「只提交改过的字段」都以它为基准，必须是响应式的
const serverBrief = ref(JSON.stringify(briefDraft.value))
const serverSpec = ref(JSON.stringify(specDraft.value))
const serverLayerOptions = ref(JSON.stringify(layerOptionsDraft.value))
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

/**
 * 后端可能给 null / 缺字段（刚建的地图资产），补齐后模板不做存在性判断。
 * `detail_level` 不能补默认值：它决定底图河道取 10m 还是 50m，丢了会让保存几何时错误地重新取景。
 */
function normalizeSpec(raw: MapSpec | null): MapSpec {
  const base = emptySpec()
  if (!raw) return base
  return {
    version: 1,
    projection: { type: raw.projection?.type === 'equirectangular' ? 'equirectangular' : 'mercator' },
    bbox: Array.isArray(raw.bbox) && raw.bbox.length === 4 ? [...raw.bbox] as MapSpec['bbox'] : base.bbox,
    ...(raw.detail_level ? { detail_level: raw.detail_level } : {}),
    layers: { ...base.layers, ...(raw.layers ?? {}) },
    places: (raw.places ?? []).map(place => ({ ...place })),
    routes: (raw.routes ?? []).map(route => ({ ...route, points: (route.points ?? []).map(pt => [pt[0], pt[1]] as [number, number]) })),
    regions: (raw.regions ?? []).map(region => ({ ...region, points: (region.points ?? []).map(pt => [pt[0], pt[1]] as [number, number]) })),
    style: { ...raw.style, theme: raw.style?.theme === 'clean' ? 'clean' : raw.style?.theme === 'ink' ? 'ink' : 'archival' },
  }
}

const stage = computed(() => detail.value?.stage ?? 'brief')
const status = computed(() => detail.value?.status ?? 'idle')
const isRunning = computed(() => status.value === 'running' || !!detail.value?.busy)
const busy = computed(() => !!action.value || loading.value || hostMissing.value)
const statusClass = computed(() => `is-${status.value}`)
const briefDirty = computed(() => JSON.stringify(briefDraft.value) !== serverBrief.value)
const specDirty = computed(() => JSON.stringify(specDraft.value) !== serverSpec.value)
const layerOptionsDirty = computed(() => JSON.stringify(layerOptionsDraft.value) !== serverLayerOptions.value)
/** 几何区一次保存的是 map_spec + layer_options：两者任一有改动都要走同一次 CAS */
const geometryDirty = computed(() => specDirty.value || layerOptionsDirty.value)
const blockingIssues = computed(() => (detail.value?.issues ?? []).filter(issue => issue.blocking))
const softIssues = computed(() => (detail.value?.issues ?? []).filter(issue => !issue.blocking))

/** 轮次账本：后端没给（旧记录 / 还没跑过模型）时按空账本显示，不编造计数 */
const EMPTY_AGENT: MapAgentState = { run_id: null, rounds: {}, rollbacks: 0, max_rounds: 3, max_rollbacks: 2, attempts: [] }
const agentState = computed<MapAgentState>(() => detail.value?.agent ?? EMPTY_AGENT)

/** 模型交付的 LayerDoc：当前成品图就是它渲染出来的；没有就没得编辑 */
const editorDoc = computed(() => (detail.value?.outputs.layer_doc as Record<string, unknown> | null) ?? null)
const canEditLayers = computed(() => !hostMissing.value && !!editorDoc.value && !isRunning.value && !busy.value)

/**
 * 当前（或失败）阶段最近一次不被接受的交付：被拒原因要贴着步骤状态显示，不用点开才看得见。
 * 只看当前阶段：别的阶段早已通过，它的旧拒绝不是现在卡住的原因。
 */
const REJECTED_OUTCOMES = ['rejected', 'no_delivery', 'error']
const latestRejection = computed<MapAgentAttempt | null>(() => {
  const attempts = agentState.value.attempts
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!
    if (attempt.stage !== stage.value) continue
    if (attempt.outcome === 'accepted') return null
    if (REJECTED_OUTCOMES.includes(attempt.outcome)) return attempt
  }
  return null
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

/** 当前预览身份对应的真实图片；产出被回退清掉时为 null（此时不显示大图，只给提示） */
const previewImage = computed(() => (previewView.value ? mapPreviewImage(previewView.value, detail.value?.outputs, registration.value) : null))
const previewTitle = computed(() => {
  const view = previewView.value
  if (!view) return ''
  const label = t(`mapStudio.results.${previewLabelKey(view)}`)
  return detail.value?.title ? `${detail.value?.title} · ${label}` : label
})

function previewLabelKey(view: MapPreviewView): string {
  return view === 'calibration' ? 'calibrationEvidence' : `${view}_image`
}

function openPreview(view: MapPreviewView) {
  previewWarning.value = ''
  previewView.value = view
}

function closePreview() {
  previewView.value = null
}

/**
 * Esc 只关自己这一层：捕获阶段拦下并停止传播，宿主（资产详情弹窗）的全局 Esc 不能顺带把资产也关掉。
 * 预览没开时完全不插手，宿主行为保持原样。
 */
function onPreviewKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !previewView.value) return
  event.stopPropagation()
  closePreview()
}
onMounted(() => window.addEventListener('keydown', onPreviewKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown, true))

/** 面板自己的键：打开写 msview，关闭只清 msview（宿主的 asset / mfocus 不受影响） */
watch(previewView, view => previewLink.set({ msview: view ?? '' }))

/**
 * 链接恢复：详情到手后才判定，因为产出是否存在只有详情说了算。
 * 非法值或该产出当前不存在 —— 给一句能读懂的提示并清掉这个键，绝不停在空白大图上。
 */
function restorePreviewFromLink() {
  if (previewRestored) return
  previewRestored = true
  const raw = previewLink.initial('msview')
  if (!raw) return
  const view = mapPreviewView(raw)
  if (!view) {
    previewWarning.value = t('mapStudio.preview.invalidLink', { value: raw })
    previewLink.set({ msview: '' })
    return
  }
  if (!mapPreviewImage(view, detail.value?.outputs, registration.value)) {
    previewWarning.value = t('mapStudio.preview.unavailable', { view: t(`mapStudio.results.${previewLabelKey(view)}`) })
    previewLink.set({ msview: '' })
    return
  }
  previewView.value = view
}

/** 产出被回退/重跑清掉时，正在看的大图不能停在旧图：给提示并关掉自己的层 */
watch(previewImage, image => {
  const view = previewView.value
  if (!view || image) return
  previewWarning.value = t('mapStudio.preview.unavailable', { view: t(`mapStudio.results.${previewLabelKey(view)}`) })
  previewView.value = null
})

/** 「编辑图层」：只开界面；真正的重绘发生在保存时，由服务端用同一条 renderLayerDoc 链做 */
function openLayerEditor() {
  if (!canEditLayers.value) return
  editorOpen.value = true
}

function closeLayerEditor() {
  editorOpen.value = false
}

/** 保存成功：服务端已登记新版本并采纳图与语义，整份详情（含成品图）按返回值更新 */
function onLayerDocSaved(next: MapStudioDetail) {
  // 图层编辑器保存也会提交 layer_options：采用服务端的结果，但不动用户在几何区尚未保存的 map_spec 草稿
  applyDetail(next, 'layer-options')
  conflict.value = null
}

/** 图层保存撞上 409：服务端状态没变，这里只回读最新修订号，编辑器里的草稿由它自己保留 */
function reloadQuiet() {
  void load(true)
}

function setAttemptStage(value: string) {
  openAttemptStage.value = value
}

function openAttempts(target: string) {
  openAttemptStage.value = target
}

/** 自己的键：开/关与展开阶段各写各的，宿主的 asset / mfocus / msview 不受影响 */
watch([editorOpen, openAttemptStage], () => agentLink.set({
  mslayer: editorOpen.value ? '1' : '',
  msround: openAttemptStage.value,
}))

/** 产出被回退清掉（layer_doc 没了）时，编辑器不能停在旧文档上 */
watch(editorDoc, doc => {
  if (!doc && editorOpen.value) {
    editorOpen.value = false
    toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.layerEditor.target') }))
  }
})

/**
 * 链接恢复：详情到手后才判定——有没有 layer_doc、某阶段有没有交付记录，只有详情说了算。
 * 恢复只开界面，绝不触发保存或重绘；目标不存在就清掉自己的键并给可读提示。
 */
const layerFallbackLink = useDeeplink('mapStudioOrphanLayer', DEEPLINK_KEYS.mapStudioLayer)
function restoreAgentFromLink() {
  if (agentRestored) return
  agentRestored = true
  const round = agentLink.initial('msround')
  if (round) {
    if (agentState.value.attempts.some(attempt => attempt.stage === round)) openAttemptStage.value = round
    else {
      agentLink.set({ msround: '' })
      toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.agent.target') }))
    }
  }
  if (agentLink.initial('mslayer') !== '1') {
    if (layerFallbackLink.initial('mssel')) {
      layerFallbackLink.set({})
      toast.warning(t('deeplink.missing'))
    }
    return
  }
  if (!editorDoc.value) {
    agentLink.set({ mslayer: '' })
    layerFallbackLink.set({})
    toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.layerEditor.target') }))
    return
  }
  editorOpen.value = true
}

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
const reviewedStage = computed<MapStudioStage | null>(() => {
  const index = STAGE_ORDER.indexOf(stage.value)
  return index > 0 ? STAGE_ORDER[index - 1] : null
})

const currentWork = computed(() => {
  if (!detail.value) return ''
  const label = t('mapStudio.stage.' + stage.value)
  if (isRunning.value) return t('mapStudio.panel.workRunning', { stage: label })
  if (status.value === 'awaiting_review') {
    const reviewed = reviewedStage.value
    return t('mapStudio.panel.workReview', { stage: reviewed ? t('mapStudio.stage.' + reviewed) : label })
  }
  if (status.value === 'blocked') return t('mapStudio.panel.workBlocked', { stage: label })
  if (status.value === 'failed') return t('mapStudio.panel.workFailed', { stage: label })
  if (status.value === 'completed' || stage.value === 'complete') return t('mapStudio.panel.workDone')
  return t('mapStudio.panel.workIdle', { stage: label })
})

/** 下一步要跑的阶段就是 detail.stage 本身（后端在每一步结束时已经推进过了） */
const nextStage = computed<MapStudioStage | null>(() => (stage.value === 'complete' ? null : stage.value))

const nextAction = computed(() => {
  if (!detail.value) return ''
  if (isRunning.value) return t('mapStudio.panel.nextRunning')
  // 草稿没保存就启动，跑的是服务端的旧值：先说清楚要先保存或放弃
  if (draftsDirty.value) return t('mapStudio.panel.nextDirty')
  if (status.value === 'blocked') {
    const first = blockingIssues.value[0]
    return first ? t('mapStudio.panel.nextBlocked', { reason: first.message }) : t('mapStudio.panel.nextBlockedGeneric')
  }
  if (status.value === 'failed') return t('mapStudio.panel.nextFailed', { stage: t('mapStudio.stage.' + stage.value) })
  if (status.value === 'awaiting_review') {
    const next = nextStage.value
    return next
      ? t('mapStudio.panel.nextReview', { stage: t('mapStudio.stage.' + next) })
      : t('mapStudio.panel.nextReviewLast')
  }
  if (stage.value === 'complete' || status.value === 'completed') return t('mapStudio.panel.nextDone')
  return runMode.value === 'auto'
    ? t('mapStudio.panel.nextAuto')
    : t('mapStudio.panel.nextManual', { stage: t('mapStudio.stage.' + stage.value) })
})

const draftsDirty = computed(() => briefDirty.value || geometryDirty.value)
const canRun = computed(() => !hostMissing.value && !!detail.value && !isRunning.value && !draftsDirty.value && !blockingIssues.value.length && stage.value !== 'complete')
const canAdvance = computed(() => canRun.value)
const runLabel = computed(() => (runMode.value === 'auto'
  ? t('mapStudio.panel.runAuto')
  : t('mapStudio.panel.runManual')))
const advanceLabel = computed(() => (status.value === 'awaiting_review'
  ? t('mapStudio.panel.approveNext')
  : t('mapStudio.panel.advance')))

function canRollbackTo(target: MapStudioStage): boolean {
  if (!detail.value || isRunning.value || hostMissing.value) return false
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
function applyDetail(next: MapStudioDetail, adopt?: 'brief' | 'spec' | 'layer-options') {
  // 首次恢复显示服务端实际固定的配置；后台刷新不覆盖用户尚未提交的新选择。
  if (!detail.value) {
    textConfigId.value = next.text_config_id ?? 0
    imageKey.value = next.image_config_id && next.image_model ? `${next.image_config_id}:${next.image_model}` : ''
  }
  detail.value = next
  const nextBrief = JSON.stringify({ ...emptyBrief(), ...next.brief })
  if (adopt === 'brief' || !briefDirty.value) briefDraft.value = JSON.parse(nextBrief) as MapBrief
  serverBrief.value = nextBrief
  const nextSpec = JSON.stringify(normalizeSpec(next.map_spec))
  if (adopt === 'spec' || !specDirty.value) specDraft.value = JSON.parse(nextSpec) as MapSpec
  serverSpec.value = nextSpec
  // 平滑参数与几何同一次保存：保存成功时采用服务端重映射后的键，未保存的改动一个字都不动
  const nextOptions = JSON.stringify(next.outputs.layer_options ?? {})
  if (adopt === 'spec' || adopt === 'layer-options' || !layerOptionsDirty.value) layerOptionsDraft.value = JSON.parse(nextOptions) as MapLayerSmoothing
  serverLayerOptions.value = nextOptions
}

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const res = await mapStudioAPI.get(taskId.value)
    if (stopped) return
    error.value = ''
    applyDetail(res)
    restorePreviewFromLink()
    restoreAgentFromLink()
  } catch (err) {
    if ((err as { status?: number })?.status === 404) {
      toast.warning(t('deeplink.missing'))
      void router.push('/map-studio')
    }
    if (!stopped) error.value = err instanceof Error && err.message ? err.message : t('mapStudio.panel.loadFailed')
  } finally {
    if (!stopped) loading.value = false
  }
}

function reload() {
  void load()
}

/** 409 冲突：服务端状态没变，本地草稿一律保留，由人决定是重新基于最新修订保存还是放弃 */
function handleError(err: unknown, fallback: string) {
  const detected = mapStudioConflictOf(err)
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
    const res = await mapStudioAPI.run(taskId.value, { mode: runMode.value, ...runOptions() })
    if (stopped) return
    applyDetail(res)
    selectedRunId.value = res.run_id
    await loadRuns()
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.runFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function advance() {
  if (busy.value || !canAdvance.value) return
  action.value = 'advance'
  error.value = ''
  try {
    const res = await mapStudioAPI.advance(taskId.value, runOptions())
    if (stopped) return
    applyDetail(res)
    selectedRunId.value = res.run_id
    await loadRuns()
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.advanceFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function cancel() {
  if (busy.value) return
  action.value = 'cancel'
  try {
    const res = await mapStudioAPI.cancel(taskId.value)
    if (stopped) return
    applyDetail(res)
    await loadRuns()
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.cancelFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function rollback(target: MapStudioStage) {
  if (busy.value) return
  action.value = 'rollback'
  try {
    const res = await mapStudioAPI.rollback(taskId.value, target, detail.value?.revision)
    if (stopped) return
    applyDetail(res)
    toast.success(t('mapStudio.panel.rolledBack', { stage: t('mapStudio.stage.' + target) }))
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.rollbackFailed'))
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
    const res = await mapStudioAPI.save(taskId.value, { expected_revision: detail.value?.revision, brief: briefPatch() })
    if (stopped) return
    applyDetail(res, 'brief')
    conflict.value = null
    toast.success(t('mapStudio.panel.briefSaved'))
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

async function saveSpec() {
  if (busy.value || !geometryDirty.value) return
  action.value = 'spec'
  error.value = ''
  try {
    // map_spec 与 layer_options 同一次 CAS。几何没改时发送服务端原样的 map_spec：
    // 后端按字节比较「几何是否变化」，只有逐字节相同才走「仅改平滑参数」的重绘路径，
    // 否则会把只改平滑当成几何变更，白白让成图失效。
    const spec = specDirty.value ? specDraft.value : (detail.value?.map_spec ?? specDraft.value)
    const res = await mapStudioAPI.save(taskId.value, {
      expected_revision: detail.value?.revision,
      map_spec: spec,
      layer_options: layerOptionsDraft.value,
    })
    if (stopped) return
    applyDetail(res, 'spec')
    conflict.value = null
    toast.success(t('mapStudio.panel.specSaved'))
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

/**
 * 确认 AI 提议几何 = PUT map_spec 去掉 proposed（现有 CAS），其余元数据逐字保留；
 * 核验结论由服务端改写，前端不自行判定放行。失败（含 409 修订冲突）时选择与草稿都不动。
 */
async function confirmGeometry(targets: MapConfirmTarget[]) {
  if (!targets.length || action.value) return
  const base = detail.value?.map_spec
  if (!base) return
  action.value = 'confirm'
  error.value = ''
  try {
    const next = confirmSpecFeatures(base, targets)
    const res = await mapStudioAPI.save(taskId.value, { expected_revision: detail.value?.revision, map_spec: next })
    if (stopped) return
    // 尚未保存的几何草稿里同一批条目仍带着 AI 候选标记：一并去掉，否则之后保存草稿会把人工确认覆盖回候选
    if (specDirty.value) specDraft.value = confirmSpecFeatures(specDraft.value, targets)
    applyDetail(res)
    conflict.value = null
    toast.success(t('mapStudio.researchPanel.confirmed', { n: targets.length }))
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

function resetBrief() {
  briefDraft.value = JSON.parse(serverBrief.value) as MapBrief
}

function resetSpec() {
  specDraft.value = JSON.parse(serverSpec.value) as MapSpec
  layerOptionsDraft.value = JSON.parse(serverLayerOptions.value) as MapLayerSmoothing
}

async function loadConfigs() {
  const options = await mapStudioAPI.modelOptions()
  modelOptions.value = options
  textConfigs.value = options.text.map(row => ({ id: row.config_id, name: row.name }))
  imageOptions.value = options.image.flatMap(row => row.models.map(model => ({ key: `${row.config_id}:${model}`, configId: row.config_id, configName: row.name, model })))
}
watch(() => detail.value?.mode, (mode) => {
  if (mode) runMode.value = mode
})

onMounted(async () => {
  try {
    await load()
    await Promise.all([loadConfigs(), loadRuns()])
  } catch (err) { handleError(err, t('mapStudio.panel.loadFailed')) }
  finally { await nextTick(); deeplinkHydrate() }
  clockTimer = setInterval(() => {
    nowMs.value = Date.now()
    if (isRunning.value) {
      void load(true)
      void loadRuns().catch(err => handleError(err, t('mapStudio.panel.loadFailed')))
    }
  }, 3000)
})

onBeforeUnmount(() => {
  stopped = true
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.ms-harness { padding: 20px 24px; overflow: auto; min-width: 1280px; }
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
.mw-step:has([aria-pressed="true"]) { outline: 2px solid var(--accent-text); outline-offset: 1px; }
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

/* 产出大图：必须盖在宿主素材详情弹窗（z-index 118）之上，否则图开了也看不见、关不掉 */
.mw-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(0, 0, 0, 0.72);
}
.mw-preview-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(1280px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  padding: 10px;
  border-radius: 10px;
  background: var(--bg-1);
}
.mw-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mw-preview-title { font-size: 12px; font-weight: 600; color: var(--text-1); }
.mw-preview-img { max-width: 100%; max-height: calc(100vh - 140px); object-fit: contain; border-radius: 6px; background: var(--bg-2); }
.mw-preview-meta { margin: 0; font-size: 10.5px; }
</style>
