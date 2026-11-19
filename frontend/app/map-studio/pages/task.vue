<template>
  <div class="mw ms-harness" @click.stop>
    <NuxtLink to="/map-studio">{{ t('mapStudio.app.title') }}</NuxtLink>
    <MapHostHeader v-if="detail" :task-id="taskId" :title="detail.title" :host="detail.host" />

    <!-- 顶栏：身份 + 状态句（打开阶段轨）+ AI 活动 + 刷新；不再放 manual/auto 开关 -->
    <header class="mw-head">
      <strong class="mw-title">{{ detail?.title ?? t('mapStudio.panel.title') }}</strong>
      <button type="button" class="mw-status" :aria-expanded="stageTrackOpen" @click="stageTrackOpen = !stageTrackOpen">{{ statusSentence }}</button>
      <span class="mw-chip dim">{{ t('mapStudio.panel.revision', { n: detail?.revision ?? 0 }) }}</span>
      <button type="button" class="mw-tool" :aria-expanded="activityOpen" @click="activityOpen = !activityOpen">
        <Activity :size="11" />
        {{ t('mapStudio.activity.open') }}
        <span v-if="isRunning" class="mw-dot is-live" />
        <span v-else-if="status === 'failed'" class="mw-dot is-warn" />
      </button>
      <button type="button" class="mw-tool" :disabled="loading" @click="reload">
        <Loader2 v-if="loading" :size="11" class="animate-spin" />
        <RefreshCw v-else :size="11" />
        {{ t('mapStudio.panel.refresh') }}
      </button>
    </header>

    <div v-if="stageTrackOpen && detail" class="mw-track">
      <ol class="mw-rail">
        <li v-for="(step, index) in detail.steps" :key="step.id" class="mw-step" :class="[`is-${step.status}`, { 'is-current': step.id === stage }]">
          <span class="mw-step-index">{{ index + 1 }}</span>
          <span class="mw-step-body">
            <button type="button" class="mw-tool" :aria-pressed="selectedStage === step.id" @click="navigationTouched = true; selectedStage = step.id">{{ t('mapStudio.stage.' + step.id) }}</button>
            <span class="mw-step-status">{{ t('mapStudio.stepStatus.' + step.status) }}</span>
            <span v-if="step.message" class="mw-step-msg">{{ step.message.includes('geometry_unverified') ? t('mapStudio.researchPanel.pendingOptional', { n: pendingCount }) : step.message }}</span>
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
      <MapStagePanel :detail="detail" :stage="selectedStage" @preview="openPreview" />
    </div>

    <p v-if="detail?.error_detail" class="mw-failure" role="alert">
      <strong>{{ t('mapStudio.failure.' + detail.error_detail.kind) }}</strong>
      <span v-if="detail.error" class="mw-failure-msg">{{ detail.error }}</span>
      <span v-if="lastFailureProblems.length" class="mw-failure-msg">{{ lastFailureProblems.join('；') }}</span>
      <button type="button" class="mw-tool" @click="activityOpen = true">{{ t('mapStudio.activity.viewFailure') }}</button>
    </p>
    <p v-else-if="detail?.error && !detail.error.includes('geometry_unverified')" class="mw-error">{{ detail.error }}</p>
    <p v-if="conflict" class="mw-conflict">
      {{ conflict.message || t('mapStudio.panel.conflictDefault') }}
      <button type="button" class="mw-tool" @click="resolveConflict('keep')">{{ t('mapStudio.panel.conflictKeep') }}</button>
      <button type="button" class="mw-tool" @click="resolveConflict('discard')">{{ t('mapStudio.panel.conflictDiscard') }}</button>
    </p>
    <p v-if="error" class="mw-error">{{ error }}</p>

    <div v-if="detail" class="mw-body" :class="layoutClass">
      <!-- ① 资产信息：需求摘要 + 宿主只读信息 + 参考图；表单收起 -->
      <section class="mw-block block-asset">
        <MapAssetSummary
          ref="assetSummary"
          :detail="detail"
          :brief="briefDraft"
          :issues="detail.issues"
          :disabled="busy"
          :brief-dirty="briefDirty"
          :compact="layoutClass === 'is-review'"
          @patch="patchBrief"
          @save="saveBrief"
          @discard="resetBrief"
        />
      </section>

      <!-- ② 当前成图：图片 + 身份 + 上一版；图层查看器是同一选中版本的只读右栏 -->
      <section class="mw-block block-image">
        <div class="block-image-grid">
          <MapCurrentImage
            :detail="detail"
            :state="imageState"
            :selected-id="selectedSnapshotId"
            :stale="staleReason"
            :compact="layoutClass === 'is-review'"
            @select="selectSnapshot"
            @preview="openVersionPreview"
            @open-layers="layersOpen = true"
          />
          <MapLayerViewer
            v-if="layersOpen"
            :model="layerModel"
            :selected-id="selectedLayerId"
            :version-title="selectedVersionLabel"
            @select="selectedLayerId = $event"
            @close="layersOpen = false"
          />
        </div>
        <p v-if="previewWarning" class="mw-warn">{{ previewWarning }}</p>
        <p v-if="newVersionNotice" class="mw-warn">
          {{ t('mapStudio.image.newVersionReady') }}
          <button type="button" class="mw-tool" @click="selectSnapshot(imageState.defaultSelection); newVersionNotice = false">{{ t('mapStudio.image.viewNewVersion') }}</button>
        </p>
      </section>

      <!-- ③ 核对与编辑：TAB/画布/条目由 MapGeoEditor 提供；核对清单与待确认要素在这里 -->
      <section class="mw-block block-geometry">
        <header class="mw-block-head">
          <strong>{{ t('mapStudio.panel.geometryTitle') }}</strong>
          <a v-if="pendingCount" href="#map-pending-geometry" class="mw-link">{{ t('mapStudio.researchPanel.pendingOptional', { n: pendingCount }) }}</a>
          <span v-if="geometryDirty" class="mw-warn-inline">{{ t('mapStudio.geometry.addedToDraft') }}</span>
          <button type="button" class="mw-tool" :disabled="busy || !geometryDirty" @click="requestSaveGeometry">
            <Loader2 v-if="action === 'spec'" :size="11" class="animate-spin" />
            {{ t('mapStudio.action.saveGeometry') }}
          </button>
          <button type="button" class="mw-tool" :disabled="busy || !geometryDirty" @click="resetSpec">{{ t('mapStudio.panel.discard') }}</button>
        </header>
        <MapGeometryReview :detail="detail" :confirming="action === 'confirm'" @confirm="confirmGeometry" @focus="geoFocus = $event" />
        <MapGeoEditor
          ref="geoEditor"
          :spec="specDraft"
          :focus-target="geoFocus"
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

      <!-- 产出与出处：底图/细节图/组合图、配准、来源；按需展开，不占用主视觉 -->
      <details v-if="detail" class="mw-block block-artifacts">
        <summary class="mw-summary">{{ t('mapStudio.results.title') }}</summary>
        <div class="mw-actions">
          <button v-if="canEditLayers" type="button" class="mw-tool" @click="openLayerEditor">
            <PenLine :size="11" />
            {{ t('mapStudio.layerEditor.open') }}
          </button>
          <span class="mw-hint dim">{{ t('mapStudio.layerEditor.entryHint') }}</span>
        </div>
        <p v-if="detail.host && stage !== 'complete'" class="mw-hint dim">{{ t('mapStudio.panel.adoptNote') }}</p>
        <MapResults
          :outputs="detail.outputs"
          :research="detail.research"
          :registration="registration"
          :style-skipped="styleSkipped"
          @preview="openPreview"
        />
      </details>

      <!-- ④ 动作条：唯一主动作 + 停靠原因 + 更多（取消/刷新/活动/回退） -->
      <MapDockBar
        :action="dockAction"
        :busy="!!action"
        :secondary="dockSecondary"
        @command="dispatchDock"
        @more="handleMore"
      />
    </div>

    <p v-if="!detail && !loading && !error" class="mw-hint dim">{{ t('mapStudio.panel.empty') }}</p>

    <MapAIActivityDrawer
      v-if="detail"
      :detail="detail"
      :runs="runs"
      :selected-run-id="selectedRunId"
      :stage="selectedStage"
      :open-stage="openAttemptStage"
      :now="nowMs"
      :open="activityOpen"
      :loading-runs="false"
      :busy="!!action"
      :text-configs="textConfigs"
      :image-options="imageOptions"
      :text-config-id="textConfigId"
      :image-key="imageKey"
      @close="activityOpen = false"
      @select-run="navigationTouched = true; selectedRunId = $event"
      @reload-runs="loadRuns"
      @open-round="openAttemptStage = $event"
      @save-models="saveModels"
      @request-auto="runAuto"
      @clear-progress="clearResearchProgress"
    />

    <!-- 产出大图 / 所选成图版本：本面板自己的层，teleport 到 body 才能稳定盖在宿主弹窗之上 -->
    <Teleport to="body">
      <div v-if="overlayContent" class="mw-preview-overlay" @click.self="closePreview">
        <div class="mw-preview-dialog">
          <div class="mw-preview-head">
            <span class="mw-preview-title">{{ overlayContent.title }}</span>
            <button type="button" class="mw-tool" @click="closePreview">
              <X :size="12" />
              {{ t('mapStudio.preview.close') }}
            </button>
          </div>
          <img :src="overlayContent.url" :alt="overlayContent.title" class="mw-preview-img" />
          <p v-if="overlayContent.meta" class="mw-preview-meta dim">{{ overlayContent.meta }}</p>
          <div class="mw-actions">
            <button type="button" class="mw-tool" @click="layersOpen = true">{{ t('mapStudio.layers.title') }}</button>
            <button v-if="imageState.versions.length > 1" type="button" class="mw-tool" @click="cycleSnapshot">{{ t('mapStudio.image.nextVersion') }}</button>
          </div>
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
 * 地图资产工作流面板（Issue #84；Issue #126 阶段 1 重排）。
 *
 * 主界面按人的工作流重排：① 资产信息 → ② 当前成图（身份/上一版/图层描述）→ ③ 核对与编辑 → ④ 唯一主动作。
 * 默认检索/渲染走有界运行 guided（base 就绪即停；显式渲染 drawing 完成即停），auto 只在 AI 活动抽屉里
 * 作为带警告的高级命令。页面是唯一的写入口：子组件只发事件，保存/确认/运行/交付都由这里派发。
 * 几何真值是 map_spec（经纬度），扩散模型只产出纹理，绝不重画地理形状。
 */
import { Activity, Loader2, PenLine, RefreshCw, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import MapHostHeader from '~/map-studio/components/MapHostHeader.vue'
import MapStagePanel from '~/map-studio/components/MapStagePanel.vue'
import MapAssetSummary from '~/map-studio/components/MapAssetSummary.vue'
import MapCurrentImage from '~/map-studio/components/MapCurrentImage.vue'
import MapGeometryReview from '~/map-studio/components/MapGeometryReview.vue'
import MapLayerViewer from '~/map-studio/components/MapLayerViewer.vue'
import MapDockBar from '~/map-studio/components/MapDockBar.vue'
import MapAIActivityDrawer from '~/map-studio/components/MapAIActivityDrawer.vue'
import MapGeoEditor from '~/map-studio/components/MapGeoEditor.vue'
import MapResults from '~/map-studio/components/MapResults.vue'
import MapLayerEditor from '~/map-studio/components/MapLayerEditor.vue'
import { mapImageState, mapLayerViewerModel, mapVersionGeometryChanged, restoreMapSelection, type MapImageVersion } from '~/map-studio/utils/mapSnapshot'
import { mapDockAction, mapDockRequest, mapDockSecondary, type MapDockAction } from '~/map-studio/utils/mapDock'
import {
  confirmSpecFeatures,
  mapPendingGeometry,
  mapStudioAPI,
  mapStudioConflictOf,
  type MapAgentState,
  type MapBrief,
  type MapConfirmTarget,
  type MapLayerSmoothing,
  type MapRunStopAt,
  type MapSpec,
  type MapStudioDetail,
  type MapStudioModelOptions,
  type MapStudioRun,
  type MapStudioStage,
} from '~/map-studio/api'
import { registrationFrom, registrationFromControlPoints, type MapRegistration } from '~/map-studio/utils/mapRegistration'
import { mapPreviewImage, mapPreviewLabel, mapPreviewView, type MapPreviewView } from '~/map-studio/utils/mapPreview'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
definePageMeta({ key: route => route.path })
const taskId = computed(() => Number(route.params.taskId))
const runs = ref<MapStudioRun[]>([])
const selectedRunId = ref<number | null>(null)
const selectedStage = ref<MapStudioStage>('brief')
const stageTrackOpen = ref(false)
const activityOpen = ref(false)
const runLink = useDeeplink('mapStudioRun', DEEPLINK_KEYS.mapStudioRun)
const activityLink = useDeeplink('mapStudioActivity', DEEPLINK_KEYS.mapStudioActivity)
let restored = false
let navigationTouched = false
const hostMissing = computed(() => !!detail.value?.host && !detail.value.host.target)
const modelOptions = ref<MapStudioModelOptions>({ text: [], image: [] })

async function loadRuns() {
  const res = await mapStudioAPI.runs(taskId.value)
  runs.value = res.runs
  if (!restored && !navigationTouched) {
    const rawStage = runLink.initial('msstage')
    if (rawStage && !STAGE_ORDER.includes(rawStage as MapStudioStage)) toast.warning(t('deeplink.missing'))
    selectedStage.value = STAGE_ORDER.includes(rawStage as MapStudioStage) ? rawStage as MapStudioStage : stage.value
    if (rawStage) stageTrackOpen.value = true
    const rawRun = Number(runLink.initial('msrun'))
    if (rawRun && !res.runs.some(run => run.id === rawRun)) toast.warning(t('deeplink.missing'))
    selectedRunId.value = rawRun ? (res.runs.some(run => run.id === rawRun) ? rawRun : null) : res.runs[0]?.id ?? null
    restored = true
  }
}
watch([selectedStage, selectedRunId], () => runLink.set({ msstage: selectedStage.value, msrun: selectedRunId.value }))
const STAGE_ORDER: MapStudioStage[] = ['brief', 'research', 'base', 'style', 'drawing', 'complete']

const detail = ref<MapStudioDetail | null>(null)
const loading = ref(false)
const error = ref('')
const action = ref<'' | 'run' | 'advance' | 'cancel' | 'rollback' | 'brief' | 'spec' | 'confirm'>('')
const lastFailureProblems = computed(() => detail.value?.error_detail?.rounds.at(-1)?.problems ?? [])
const conflict = ref<{ kind: 'revision' | 'busy'; message: string } | null>(null)
const textConfigId = ref(0)
const imageKey = ref('')
const textConfigs = ref<Array<{ id: number; name: string }>>([])
const imageOptions = ref<Array<{ key: string; configId: number; configName: string; model: string }>>([])

/** 编辑器暴露的「未完成局部编辑」检查：保存几何前必须收尾（03 §5.2），不静默漏交。 */
const geoEditor = ref<{ hasPendingInput?: () => boolean; focusPendingInput?: () => void } | null>(null)
const assetSummary = ref<{ openEdit?: () => void } | null>(null)

/**
 * 模型轮次与图层编辑器（Issue #90）：本面板自己的 deeplink 组 mapAgent。
 * mslayer=1 只开编辑器界面（恢复绝不触发保存/重绘），msround 记住展开的阶段。
 */
const agentLink = useDeeplink('mapAgent', DEEPLINK_KEYS.mapStudioAgent)
const editorOpen = ref(false)
const openAttemptStage = ref('')
const nowMs = ref(Date.now())
let agentRestored = false
let clockTimer: ReturnType<typeof setInterval> | null = null

/**
 * 成图版本与图层查看器（Issue #126）：msview 保留旧的产出身份；mssnapshot/mspreview/mslayers
 * 与 mssel 只恢复视图，恢复绝不触发保存、确认、生成或交付。
 */
const previewLink = useDeeplink('mapPreview', DEEPLINK_KEYS.mapStudioPreview)
const imageLink = useDeeplink('mapStudioImage', DEEPLINK_KEYS.mapStudioImage)
const layerLink = useDeeplink('mapStudioLayer', DEEPLINK_KEYS.mapStudioLayer)
const previewView = ref<MapPreviewView | null>(null)
const previewVersion = ref<MapImageVersion | null>(null)
const previewWarning = ref('')
const selectedSnapshotId = ref<string | null>(null)
const selectedLayerId = ref<string | null>(null)
const layersOpen = ref(false)
const newVersionNotice = ref(false)
let previewRestored = false
let imageRestored = false
let layerRestored = false

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
const geoFocus = ref<{ kind: 'place' | 'route' | 'region'; id: string } | null>(null)
const pendingCount = computed(() => mapPendingGeometry(detail.value?.map_spec ?? null).length + (detail.value?.research?.missing_geometry?.length ?? 0))
const researchResumable = computed(() => detail.value?.research_progress_summary?.available === true)

/**
 * 底纹阶段已完成/被跳过且确实没有纹理图（Issue #107）：成品直接用底图绘制，这是新口径而不是失败。
 */
const styleSkipped = computed(() => {
  const step = detail.value?.steps.find(item => item.id === 'style')
  if (!step || !detail.value?.outputs.base_image) return false
  return (step.status === 'skipped' || step.status === 'completed') && !detail.value.outputs.texture_image
})

/** 轮次账本：后端没给（旧记录 / 还没跑过模型）时按空账本显示，不编造计数 */
const EMPTY_AGENT: MapAgentState = { run_id: null, rounds: {}, rollbacks: 0, max_rounds: 3, max_rollbacks: 2, attempts: [] }
const agentState = computed<MapAgentState>(() => detail.value?.agent ?? EMPTY_AGENT)

/** 模型交付的 LayerDoc：当前成品图就是它渲染出来的；没有就没得编辑 */
const editorDoc = computed(() => (detail.value?.outputs.layer_doc as Record<string, unknown> | null) ?? null)
const canEditLayers = computed(() => !hostMissing.value && !!editorDoc.value && !isRunning.value && !busy.value)

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

/* ===== 成图版本、图层查看器、全屏预览 ===== */

const imageState = computed(() => (detail.value ? mapImageState(detail.value) : { versions: [], current: null, previous: null, base: null, defaultSelection: null }))
const selectedVersion = computed<MapImageVersion | null>(() => {
  if (!selectedSnapshotId.value) return imageState.value.current ?? imageState.value.versions[0] ?? imageState.value.base
  if (imageState.value.base?.snapshotId === selectedSnapshotId.value) return imageState.value.base
  return imageState.value.versions.find(version => version.snapshotId === selectedSnapshotId.value) ?? imageState.value.versions[0] ?? null
})
const selectedVersionLabel = computed(() => {
  const version = selectedVersion.value
  if (!version) return t('mapStudio.image.title')
  const revision = version.publishedRevision === null ? t('mapStudio.image.notRecorded') : `r${version.publishedRevision}`
  return `${t(version.kind === 'previous' ? 'mapStudio.image.previous' : 'mapStudio.image.final')} · ${revision}`
})
const layerModel = computed(() => (selectedVersion.value ? mapLayerViewerModel(selectedVersion.value.payload, detail.value?.map_spec ?? null) : { available: false, layers: [] }))
const staleReason = computed<'geometry' | 'options' | 'brief' | null>(() => {
  const codes = new Set((detail.value?.issues ?? []).map(issue => issue.code))
  if (codes.has('geometry_changed')) return 'geometry'
  if (codes.has('layer_options_changed')) return 'options'
  if (codes.has('brief_changed')) return 'brief'
  if (selectedVersion.value && mapVersionGeometryChanged(detail.value!, selectedVersion.value)) return 'geometry'
  return null
})

/** 预览身份对应的真实图片；产出被回退清掉时为 null（此时不显示大图，只给提示） */
const previewImage = computed(() => (previewView.value ? mapPreviewImage(previewView.value, detail.value?.outputs, registration.value) : null))
const previewLabel = computed(() => {
  const view = previewView.value
  if (!view) return ''
  const label = mapPreviewLabel(view, detail.value?.outputs)
  return t(`mapStudio.results.${label.key}`, label.params ?? {})
})

const overlayContent = computed(() => {
  if (previewVersion.value) {
    return {
      url: previewVersion.value.url,
      title: `${selectedVersionLabel.value} · ${t('mapStudio.results.size', { w: previewVersion.value.width, h: previewVersion.value.height })}`,
      meta: `${t('mapStudio.image.run')}: ${previewVersion.value.runId === null ? t('mapStudio.image.notRecorded') : previewVersion.value.runId} · ${previewVersion.value.snapshotId}`,
    }
  }
  if (previewImage.value) {
    return {
      url: previewImage.value.url,
      title: detail.value?.title ? `${detail.value.title} · ${previewLabel.value}` : previewLabel.value,
      meta: (previewImage.value.source ? `${t('mapStudio.results.size', { w: previewImage.value.width, h: previewImage.value.height })} · ${t('mapStudio.results.source', { source: previewImage.value.source })}` : t('mapStudio.results.size', { w: previewImage.value.width, h: previewImage.value.height })),
    }
  }
  return null
})

function openPreview(view: MapPreviewView) {
  previewVersion.value = null
  previewWarning.value = ''
  previewView.value = view
}

function openVersionPreview(version: MapImageVersion | null) {
  if (!version) return
  previewView.value = null
  previewWarning.value = ''
  previewVersion.value = version
}

function closePreview() {
  previewView.value = null
  previewVersion.value = null
}

function cycleSnapshot() {
  const list = imageState.value.versions.length ? imageState.value.versions : [imageState.value.base].filter((item): item is MapImageVersion => !!item)
  if (list.length < 2) return
  const index = list.findIndex(version => version.snapshotId === selectedVersion.value?.snapshotId)
  const next = list[(index + 1) % list.length]!
  selectedSnapshotId.value = next.snapshotId
  previewVersion.value = next
}

function selectSnapshot(snapshotId: string | null) {
  selectedSnapshotId.value = snapshotId
  newVersionNotice.value = false
  if (previewVersion.value) previewVersion.value = null
}

/**
 * Esc 只关自己这一层：捕获阶段拦下并停止传播，宿主（资产详情弹窗）的全局 Esc 不能顺带把资产也关掉。
 */
function onPreviewKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!previewView.value && !previewVersion.value)) return
  event.stopPropagation()
  closePreview()
}
onMounted(() => window.addEventListener('keydown', onPreviewKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown, true))

watch(previewView, view => previewLink.set({ msview: view ?? '' }))

/** 图片层自己的键：开关、所选版本、全屏、所选图层；恢复只改视图。 */
watch([selectedSnapshotId, layersOpen, selectedLayerId, previewVersion], () => {
  imageLink.set({
    mssnapshot: selectedSnapshotId.value ?? '',
    mslayers: layersOpen.value ? '1' : '',
    mspreview: previewVersion.value ? '1' : '',
  })
  layerLink.set({ mssel: selectedLayerId.value ?? '' })
})
watch(activityOpen, open => activityLink.set({ msactivity: open ? '1' : '' }))

/** 选中版本消失（重跑/回退清掉了图片）时回落默认并给出可读提示，不停在空白大图上。 */
watch(imageState, state => {
  if (selectedSnapshotId.value && !state.versions.some(version => version.snapshotId === selectedSnapshotId.value) && state.base?.snapshotId !== selectedSnapshotId.value) {
    selectedSnapshotId.value = state.defaultSelection
    previewVersion.value = null
    toast.warning(t('mapStudio.preview.unavailable', { view: t('mapStudio.image.title') }))
    return
  }
  if (!selectedSnapshotId.value) selectedSnapshotId.value = state.defaultSelection
  if (imageRestored && selectedSnapshotId.value && state.defaultSelection && selectedSnapshotId.value !== state.defaultSelection) newVersionNotice.value = true
})

/** 链接恢复：详情到手后才判定，因为版本清单只有详情说了算；只恢复视图，绝不触发写请求。 */
function restoreImageFromLink() {
  if (!imageRestored) {
    imageRestored = true
    const raw = imageLink.initial('mssnapshot')
    const restoredSelection = restoreMapSelection(raw, imageState.value)
    if (restoredSelection.warning) {
      previewWarning.value = t('mapStudio.preview.invalidLink', { value: raw ?? '' })
      imageLink.set({ mssnapshot: '' })
    }
    selectedSnapshotId.value = restoredSelection.snapshotId
    if (imageLink.initial('mslayers') === '1') layersOpen.value = true
    const wantsPreview = imageLink.initial('mspreview') === '1'
    if (wantsPreview) {
      const version = imageState.value.versions.find(item => item.snapshotId === selectedSnapshotId.value) ?? imageState.value.base
      if (version) previewVersion.value = version
    }
  }
  if (!layerRestored) {
    const rawLayer = layerLink.initial('mssel')
    if (rawLayer) {
      layerRestored = true
      if (layerModel.value.layers.some(layer => layer.id === rawLayer)) {
        selectedLayerId.value = rawLayer
        layersOpen.value = true
      } else {
        layerLink.set({})
        toast.warning(t('deeplink.missing'))
      }
    }
  }
  if (!previewRestored) {
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
      const label = mapPreviewLabel(view, detail.value?.outputs)
      previewWarning.value = t('mapStudio.preview.unavailable', { view: t(`mapStudio.results.${label.key}`, label.params ?? {}) })
      previewLink.set({ msview: '' })
      return
    }
    previewView.value = view
  }
}

/** 产出被回退/重跑清掉时，正在看的大图不能停在旧图：给提示并关掉自己的层 */
watch(previewImage, image => {
  const view = previewView.value
  if (!view || image) return
  const label = mapPreviewLabel(view, detail.value?.outputs)
  previewWarning.value = t('mapStudio.preview.unavailable', { view: t(`mapStudio.results.${label.key}`, label.params ?? {}) })
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
  applyDetail(next, 'layer-options')
  conflict.value = null
}

/** 图层保存撞上 409：服务端状态没变，这里只回读最新修订号，编辑器里的草稿由它自己保留 */
function reloadQuiet() {
  void load(true)
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
  if (agentLink.initial('mslayer') !== '1') return
  if (!editorDoc.value) {
    agentLink.set({ mslayer: '' })
    toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.layerEditor.target') }))
    return
  }
  editorOpen.value = true
}

function restoreActivityFromLink() {
  const raw = activityLink.initial('msactivity')
  if (raw === '1' || raw === 'full') activityOpen.value = true
  else if (raw) {
    activityLink.set({ msactivity: '' })
    toast.warning(t('deeplink.missing'))
  }
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

const hasFinal = computed(() => !!detail.value?.outputs.final_image)
/** 核对阶段③最大、成图复核阶段②最大（设计 01 §2）。 */
const layoutClass = computed(() => (hasFinal.value || stage.value === 'complete' ? 'is-rendered' : 'is-review'))

/** 顶栏状态句：按完成步骤与产物解释，不伪造服务端阶段名。 */
const statusSentence = computed(() => {
  if (!detail.value) return t('mapStudio.panel.title')
  if (isRunning.value) return t('mapStudio.statusSentence.running', { stage: t('mapStudio.stage.' + stage.value) })
  if (status.value === 'failed') return t('mapStudio.statusSentence.failed', { stage: t('mapStudio.stage.' + stage.value) })
  if (status.value === 'blocked') return t('mapStudio.statusSentence.blocked', { stage: t('mapStudio.stage.' + stage.value) })
  if (stage.value === 'complete') {
    return status.value === 'completed'
      ? t('mapStudio.statusSentence.completed')
      : t('mapStudio.statusSentence.renderReady')
  }
  const baseDone = detail.value.steps.some(step => step.id === 'base' && step.status === 'completed')
  if (baseDone) return t('mapStudio.statusSentence.baseReady')
  return t('mapStudio.statusSentence.pending', { stage: t('mapStudio.stage.' + stage.value) })
})

/* ===== 动作条 ===== */

const dockAction = computed<MapDockAction>(() => mapDockAction({
  detail: detail.value,
  briefDirty: briefDirty.value,
  geometryDirty: geometryDirty.value,
  conflict: !!conflict.value,
  hostMissing: hostMissing.value,
  pendingCount: pendingCount.value,
  researchResumable: researchResumable.value,
}))
const dockSecondary = computed(() => mapDockSecondary(detail.value))

/** 保存几何前先收尾未完成的局部编辑；否则页面会把没画完的形状悄悄排除在外。 */
function pendingInputWarned(): boolean {
  if (!geoEditor.value?.hasPendingInput?.()) return false
  geoEditor.value.focusPendingInput?.()
  toast.warning(t('mapStudio.geometry.pendingInput'))
  return true
}

function dispatchDock(dock: MapDockAction) {
  switch (dock.code) {
    case 'saveBrief': return void saveBrief()
    case 'saveGeometry': return requestSaveGeometry()
    case 'confirm': return confirmAllPending()
    case 'search': return void run('guided', 'base')
    case 'render': return void run('guided', 'drawing')
    case 'deliver': case 'retryDeliver': return void advance()
    case 'resumeStage': case 'retryStage': case 'continueResearch': {
      const request = mapDockRequest(dock, detail.value)
      if (request.kind === 'run' && request.mode === 'guided' && request.stopAt) return void run('guided', request.stopAt)
      return void run('manual')
    }
    case 'viewDelivery': return void (activityOpen.value = true)
    case 'viewMap': return void openVersionPreview(selectedVersion.value)
    case 'completeBrief': case 'reviewBase':
      assetSummary.value?.openEdit?.()
      toast.warning(t('mapStudio.dock.reviewBrief'))
      return
    case 'fixModel': case 'viewError': case 'chooseRun': case 'resolveProblems':
      activityOpen.value = true
      return
    default: return void load(true)
  }
}

function handleMore(item: 'cancel' | 'refresh' | 'activity' | 'rollback') {
  if (item === 'cancel') return void cancel()
  if (item === 'refresh') return void load()
  if (item === 'activity') { activityOpen.value = true; return }
  if (item === 'rollback' && reviewedStage.value) void rollback(reviewedStage.value)
}

function requestSaveGeometry() {
  if (busy.value || !geometryDirty.value) return
  if (pendingInputWarned()) return
  void saveSpec()
}

function confirmAllPending() {
  const targets = mapPendingGeometry(detail.value?.map_spec ?? null)
    .filter(row => !row.reasons.some(reason => reason.includes('dataset_missing')))
    .map(row => ({ kind: row.kind, id: row.id }))
  if (!targets.length) { void load(true); return }
  void confirmGeometry(targets)
}

function canRollbackTo(target: MapStudioStage): boolean {
  if (!detail.value || isRunning.value || hostMissing.value) return false
  const current = STAGE_ORDER.indexOf(stage.value)
  const index = STAGE_ORDER.indexOf(target)
  return index >= 0 && index <= current
}

/**
 * 写回服务端快照。
 * 刚保存成功时只采用所保存部分的服务端版本；保存说明不能清掉另一份尚未保存的几何草稿，反之亦然。
 * 其余情况（任务刷新、冲突后回读）只在本地没有改动时才跟随服务端——有改动就一个字都不动。
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
    restoreImageFromLink()
    restoreAgentFromLink()
    restoreActivityFromLink()
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

async function clearResearchProgress() {
  if (busy.value || isRunning.value || !detail.value?.research_progress_summary?.available) return
  action.value = 'run'
  error.value = ''
  try {
    await mapStudioAPI.clearResearchProgress(taskId.value)
    await load(true)
  } catch (err) {
    if (!stopped) handleError(err, t('mapStudio.panel.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

/** 唯一写运行入口：默认 guided 有界运行；auto 只在抽屉确认后调用。 */
async function run(mode: 'guided' | 'manual' | 'auto', stopAt?: MapRunStopAt) {
  if (busy.value || hostMissing.value) return
  if (mode === 'guided' && !stopAt) return
  action.value = 'run'
  error.value = ''
  try {
    const res = await mapStudioAPI.run(taskId.value, { mode, ...(stopAt ? { stop_at: stopAt } : {}), ...runOptions() })
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

function runAuto() {
  void run('auto')
}

async function advance() {
  if (busy.value || hostMissing.value) return
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
  // 双层守卫：requestSaveGeometry 已拦截，这里再兜一次，避免将来新入口把未收尾的局部编辑静默排除。
  if (pendingInputWarned()) return
  action.value = 'spec'
  error.value = ''
  try {
    // map_spec 与 layer_options 同一次 CAS。几何没改时发送服务端原样的 map_spec：
    // 后端按字节比较「几何是否变化」，逐字节相同才走「仅改平滑参数」的持久化路径。
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

/** 抽屉里切换模型：显式保存设置，不自动重试；运行中也拒绝保存。 */
async function saveModels(payload: { textConfigId: number; imageKey: string }) {
  if (busy.value || isRunning.value) return
  const image = imageOptions.value.find(option => option.key === payload.imageKey) ?? null
  action.value = 'brief'
  try {
    await mapStudioAPI.saveSettings({
      models: {
        text_config_id: payload.textConfigId || null,
        image_config_id: image?.configId ?? null,
        image_model: image?.model ?? null,
      },
    })
    textConfigId.value = payload.textConfigId
    imageKey.value = payload.imageKey
    await loadConfigs()
    toast.success(t('mapStudio.settings.modelsSaved'))
  } catch (err) {
    handleError(err, t('mapStudio.settings.saveFailed'))
  } finally {
    if (!stopped) action.value = ''
  }
}

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
.mw-status {
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--accent-text);
  background: transparent;
  color: var(--accent-text);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mw-head .mw-status { margin-left: 6px; }
.mw-head > .mw-tool:nth-last-of-type(2) { margin-left: auto; }
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
.mw-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-left: 2px; }
.mw-dot.is-live { background: var(--accent-text); }
.mw-dot.is-warn { background: var(--warn-text); }
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
.mw-link { color: var(--accent-text); font-size: 10.5px; text-decoration: none; }
.mw-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.mw-failure {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--warn-border);
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 11px;
}
.mw-failure-msg { font-size: 10.5px; word-break: break-word; }
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
.mw-warn-inline { font: 600 10.5px var(--font-body); color: var(--warn-text); }
.mw-track { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
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
  background: var(--bg-1);
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
.mw-step-status { font-size: 10px; }
.mw-step-msg { font-size: 10px; word-break: break-word; }
.mw-body { display: flex; flex-direction: column; gap: 12px; }
.mw-block { display: flex; flex-direction: column; gap: 8px; }
.block-asset { flex: 0 0 auto; }
.block-image-grid { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.block-image-grid > :first-child { flex: 1 1 auto; min-width: 0; }
/* 核对阶段：③ 点线面最大，② 只保留身份与缩略；成图复核阶段：② 成图最大，③ 收窄内部滚动。 */
.mw-body.is-review .block-geometry { min-height: 520px; }
.mw-body.is-review .block-image { max-height: 320px; overflow: auto; }
.mw-body.is-rendered .block-image { min-height: 420px; }
.mw-body.is-rendered .block-geometry { max-height: 320px; overflow: auto; }
.block-artifacts { padding-top: 8px; border-top: 1px dashed var(--border); }
.mw-summary { cursor: pointer; font: 600 11px var(--font-body); color: var(--text-1); }
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
.mw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }

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
