<template>
  <div class="rw">
    <!-- 执行入口与运行记录 -->
    <div class="rw-top">
      <button class="btn btn-sm btn-primary" :disabled="rw.busy.value || rw.runActive.value || !hasSource" @click="runAll">
        <Loader2 v-if="rw.runActive.value" :size="11" class="animate-spin" />
        {{ t('episode.rewrite.narrationRunAll') }}
      </button>
      <button
        class="btn btn-sm"
        :disabled="rw.busy.value || rw.runActive.value || !hasSource"
        :title="t('episode.rewrite.skipAllHint')"
        @click="skipAll"
      >
        {{ t('episode.rewrite.skipAll') }}
      </button>

      <span v-if="rw.currentRun.value" class="rw-run mono">
        {{ t('episode.rewrite.runLabel', { id: rw.currentRun.value.id }) }}
        ·
        <template v-if="rw.stagePosition.value">
          {{ t('episode.rewrite.runStagePosition', {
            index: rw.stagePosition.value.index,
            total: rw.stagePosition.value.total,
            name: stageName(rw.stagePosition.value.key),
          }) }}
        </template>
        <template v-else>{{ t(`episode.rewrite.runStatus.${rw.currentRun.value.status}`) }}</template>
      </span>
      <span v-else-if="rw.loaded.value" class="dim rw-run">{{ t('episode.rewrite.noRun') }}</span>

      <span class="ml-auto" />
      <label v-if="rw.state.value.runs.length > 1" class="rw-history">
        <span class="dim">{{ t('episode.rewrite.history') }}</span>
        <select class="input rw-history-select" :value="String(rw.viewRunId.value ?? '')" @change="pickRun($event)">
          <option value="">{{ t('episode.rewrite.historyLatest') }}</option>
          <option v-for="run in rw.state.value.runs" :key="run.id" :value="String(run.id)">
            {{ t('episode.rewrite.runOption', { id: run.id, status: t(`episode.rewrite.runStatus.${run.status}`) }) }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="rw.loadError.value" class="rw-error">{{ rw.loadError.value }}</p>
    <p v-if="rw.viewingHistory.value" class="rw-hint">{{ t('episode.rewrite.viewingHistory') }}</p>
    <p v-if="runFailure" class="rw-error">{{ t('episode.rewrite.runFailed', { message: runFailure }) }}</p>

    <!-- 原文被改且要从旧前驱继续：必须人工确认，不悄悄混用两代原文 -->
    <div v-if="sourceChangePrompt" class="rw-ack">
      <span>{{ t('episode.rewrite.sourceChanged') }}</span>
      <button class="btn btn-sm" :disabled="rw.busy.value" @click="sourceChangePrompt = null">{{ t('common.cancel') }}</button>
      <button class="btn btn-sm btn-primary" :disabled="rw.busy.value" @click="confirmSourceChange">
        {{ t('episode.rewrite.sourceChangedConfirm') }}
      </button>
    </div>

    <StageStrip
      :stages="rw.strip.value"
      :selected="selectedStage"
      :run-active="rw.runActive.value"
      :busy="rw.busy.value"
      :final-state="finalState"
      @select="selectStage"
      @rerun="key => startFrom(key, false)"
      @skip="key => startFrom(key, true)"
      @retry="key => startFrom(key, false)"
    />

    <div class="rw-body">
      <!-- 左：只读阶段输出 / 差异 / 报告（浏览历史不改最终稿） -->
      <section class="rw-preview" :class="{ 'is-collapsed': !previewOpen }">
        <header class="rw-sec-head">
          <button type="button" class="rw-collapse" :aria-expanded="previewOpen" @click="previewOpen = !previewOpen">
            {{ previewOpen ? '▾' : '▸' }}
          </button>
          <strong class="rw-sec-title">{{ t('episode.rewrite.previewTitle', { name: stageName(selectedStage) }) }}</strong>

          <select
            v-if="stageVersions.length > 1"
            class="input rw-version-select"
            :value="String(previewVersion?.id || '')"
            @change="pickVersion($event)"
          >
            <option v-for="version in stageVersions" :key="version.id" :value="String(version.id)">
              {{ t('episode.rewrite.versionOption', {
                id: version.id,
                run: version.run_id ?? '—',
                source: t(`episode.rewrite.versionSource.${version.source}`),
              }) }}
            </option>
          </select>

          <span class="ml-auto" />
          <div class="rw-modes">
            <button type="button" :class="['btn', 'btn-sm', { 'is-on': diffMode === 'diff' }]" @click="diffMode = 'diff'">
              {{ t('episode.rewrite.modeDiff') }}
            </button>
            <button type="button" :class="['btn', 'btn-sm', { 'is-on': diffMode === 'plain' }]" @click="diffMode = 'plain'">
              {{ t('episode.rewrite.modePlain') }}
            </button>
          </div>
        </header>

        <div v-if="previewOpen" class="rw-preview-body">
          <template v-if="!previewVersion">
            <p class="rw-empty">{{ t('episode.rewrite.noVersion') }}</p>
          </template>
          <template v-else>
            <div class="rw-meta">
              <span class="dim">
                {{ predecessorVersion
                  ? t('episode.rewrite.basedOn', {
                    name: stageName(predecessorVersion.stage_key),
                    id: predecessorVersion.id,
                  })
                  : t('episode.rewrite.basedOnRaw') }}
              </span>
              <span v-if="isSkipVersion" class="tag">{{ t('episode.rewrite.skipCopy') }}</span>
              <span v-if="rw.isStaleSource(previewVersion)" class="tag rw-tag-warn">{{ t('episode.rewrite.staleSource') }}</span>
              <span v-if="!rw.adoptedChain.value.has(previewVersion.id)" class="tag">{{ t('episode.rewrite.notAdoptedChain') }}</span>
              <span class="ml-auto" />
              <button
                class="btn btn-sm"
                :disabled="rw.busy.value || previewVersion.stage_key === 'source_snapshot'"
                @click="adoptVersion(previewVersion.id)"
              >{{ t('episode.rewrite.adoptThis') }}</button>
            </div>

            <pre v-if="diffMode === 'plain'" class="rw-plain">{{ previewVersion.content }}</pre>
            <DiffView v-else :before="predecessorVersion?.content || ''" :after="previewVersion.content" />

            <FilterReport v-if="selectedStage === 'prepared_source'" :report="previewVersion.report" />
            <BridgeReport v-else-if="selectedStage === 'bridge'" :report="previewVersion.report" />
            <section v-else-if="fidelityReport" class="rw-fidelity">
              <header class="rw-sec-head">
                <strong class="rw-sec-title">{{ t('episode.rewrite.fidelity.title') }}</strong>
                <span :class="['tag', 'mono', fidelityReport.within_tolerance === false ? 'rw-tag-warn' : '']">
                  {{ t('episode.rewrite.fidelity.delta', {
                    baseline: fidelityReport.baseline_chars ?? 0,
                    output: fidelityReport.output_chars ?? 0,
                    percent: deltaPercent,
                  }) }}
                </span>
              </header>
              <p v-if="fidelityReport.within_tolerance === false" class="rw-error">{{ t('episode.rewrite.fidelity.outOfTolerance') }}</p>
              <ul v-if="overLimitParagraphs.length" class="rw-list">
                <li v-for="item in overLimitParagraphs" :key="item.index">
                  {{ t('episode.rewrite.fidelity.overLimit', { index: item.index, chars: item.chars }) }}
                </li>
              </ul>
              <ul v-if="fidelityWarnings.length" class="rw-list">
                <li v-for="(warn, i) in fidelityWarnings" :key="i">{{ warn }}</li>
              </ul>
              <div v-if="fidelityReport.ai_exclusions?.length">
                <strong>{{ t('episode.rewrite.aiExclusions') }}</strong>
                <ul class="rw-list">
                  <li v-for="(item, i) in fidelityReport.ai_exclusions" :key="i">
                    <pre class="rw-plain">{{ item.text }}</pre>{{ item.reason }}
                  </li>
                </ul>
              </div>
              <FilterReport v-if="fidelityReport.post_filter" :report="fidelityReport.post_filter" />
            </section>
          </template>
        </div>
      </section>

      <!-- 右：当前最终稿（唯一可编辑正文） -->
      <section class="rw-final">
        <header class="rw-sec-head">
          <strong class="rw-sec-title">{{ t('episode.rewrite.narrationFinalTitle') }}</strong>
          <span class="dim rw-origin">{{ finalOriginLabel }}</span>
          <span v-if="dirty" class="tag rw-tag-warn">{{ t('episode.rewrite.unsaved') }}</span>
          <span v-else class="tag">{{ t('episode.rewrite.saved') }}</span>
          <span class="ml-auto" />
          <span v-if="finalChars" class="char-count mono">{{ t('episode.script.charCount', { n: finalChars }) }}</span>
          <button class="btn btn-sm btn-primary" :disabled="!rw.loaded.value || !dirty || rw.busy.value || editLocked || checking || inspection" @click="saveFinal">
            {{ t('episode.rewrite.narrationSave') }}
          </button>
        </header>

        <p class="rw-hint">{{ t('episode.rewrite.narrationHint') }}</p>
        <div v-if="checking" class="rw-hint">{{ t('episode.rewrite.checking') }}</div>
        <Teleport to="body">
          <div v-if="inspection" class="overlay" @click.self="inspection = null">
            <div class="dialog rw-inspection-dialog" role="dialog" aria-modal="true" :aria-label="t(inspection.failed ? 'episode.rewrite.inspectionFailed' : 'episode.rewrite.inspectionFound')">
              <div class="dialog-body rw-inspection-body">
                <strong>{{ t(inspection.failed ? 'episode.rewrite.inspectionFailed' : 'episode.rewrite.inspectionFound') }}</strong>
                <ul v-if="!inspection.failed" class="rw-list">
                  <li v-for="(item, index) in inspection.findings" :key="index">
                    <pre class="rw-plain">{{ item.text }}</pre>
                    {{ item.reason }} <span v-if="!item.locatable">{{ t('episode.rewrite.notLocatable') }}</span>
                  </li>
                </ul>
              </div>
              <footer class="dialog-foot">
                <button class="btn btn-sm" @click="inspection = null">{{ t('common.cancel') }}</button>
                <button v-if="!inspection.failed && inspection.findings.some(item => item.locatable)" class="btn btn-sm" @click="finishInspection(true)">{{ t('episode.rewrite.deleteAndSave') }}</button>
                <button class="btn btn-sm btn-primary" @click="finishInspection(false)">{{ t(inspection.failed ? 'episode.rewrite.saveAnyway' : 'episode.rewrite.keepAndSave') }}</button>
              </footer>
            </div>
          </div>
        </Teleport>

        <div v-if="editLocked" class="rw-lock">
          <span>{{ t('episode.rewrite.editLocked') }}</span>
          <button class="btn btn-sm" :disabled="rw.busy.value" @click="unlockEditing">
            {{ t('episode.rewrite.editLockedAction') }}
          </button>
        </div>
        <p v-else-if="rw.currentRun.value?.auto_adopt === false" class="rw-hint">
          {{ t('episode.rewrite.manualMode') }}
        </p>
        <p v-if="externalChange" class="rw-ack">
          <span>{{ t('episode.rewrite.externalChange') }}</span>
          <button class="btn btn-sm" @click="compareExternal">{{ t('episode.rewrite.externalCompare') }}</button>
          <button class="btn btn-sm" @click="acceptExternal">{{ t('episode.rewrite.externalTake') }}</button>
        </p>

        <textarea
          ref="editorEl"
          class="rw-editor"
          v-model="finalDraft"
          :readonly="editLocked || !rw.loaded.value || checking || !!inspection"
          :placeholder="t('episode.rewrite.narrationFinalTitle')"
        />
      </section>
    </div>

    <!-- 候选：成功但未写入最终稿时才出现 -->
    <div v-if="candidate" class="rw-candidate">
      <span class="mono">{{ t('episode.rewrite.candidate', { run: candidate.run_id ?? '—', id: candidate.id }) }}</span>
      <span v-if="rw.currentRun.value?.adoption_status === 'conflict'" class="tag rw-tag-warn">
        {{ t('episode.rewrite.candidateConflict') }}
      </span>
      <span class="ml-auto" />
      <button class="btn btn-sm" @click="selectStage(candidate.stage_key)">{{ t('episode.rewrite.candidateCompare') }}</button>
      <button class="btn btn-sm btn-primary" :disabled="rw.busy.value" @click="adoptVersion(candidate.id)">
        {{ t('episode.rewrite.candidateAdopt') }}
      </button>
    </div>

    <ConflictDialog
      v-if="rw.conflict.value"
      :kind="rw.conflict.value.kind"
      :mine="rw.conflict.value.mine"
      :current="currentServerContent"
      :message="rw.conflict.value.message"
      :busy="rw.busy.value"
      @close="rw.conflict.value = null"
      @keep="keepCurrentFinal"
      @apply="applyConflict"
    />
  </div>
</template>

<script setup>
/**
 * 分阶段改写工作台（Issue #70，纪录片）。
 *
 * 画布左侧是**只读**的阶段输出与差异，右侧是唯一可编辑的最终稿：浏览历史、切换阶段、
 * 切换差异模式都不得改写最终稿。差异一律对比「该版本实际使用的前驱」，不是页面上恰好
 * 选中的上一步。运行进度来自全局任务 store，本组件不另起轮询。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'

import StageStrip from '~/components/ScriptRewrite/StageStrip.vue'
import DiffView from '~/components/ScriptRewrite/DiffView.vue'
import FilterReport from '~/components/ScriptRewrite/FilterReport.vue'
import BridgeReport from '~/components/ScriptRewrite/BridgeReport.vue'
import ConflictDialog from '~/components/ScriptRewrite/ConflictDialog.vue'
import { useScriptRewrite } from '~/composables/useScriptRewrite'
import { onTaskFinished } from '~/composables/useTasks'
import { scriptRewriteAPI } from '~/composables/useApi'
import { inspectDraftForSave, applyInspectionChoice } from '~/utils/narrationInspection'

const props = defineProps({
  episodeId: { type: Number, required: true },
  /** 当前最终稿（episodes.script_content），由页面传入，保存后回流 */
  finalContent: { type: String, default: '' },
  rawContent: { type: String, default: '' },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['refresh'])

const { t, te } = useI18n()
const rw = useScriptRewrite(() => props.episodeId)

const selectedStage = ref('prepared_source')
const editorEl = ref(null)
const pickedVersion = ref({})
const diffMode = ref('diff')
const previewOpen = ref(true)
const finalDraft = ref(props.finalContent)
const baseline = ref(props.finalContent)
const externalChange = ref(false)
const draftRevision = ref(null)
const sourceChangePrompt = ref(null)
const checking = ref(false)
const inspection = ref(null)


const storeKey = computed(() => `huobao:rewrite:${props.episodeId}`)

const hasSource = computed(() => Boolean((props.rawContent || '').trim()))
const dirty = computed(() => finalDraft.value !== baseline.value)
const finalChars = computed(() => finalDraft.value.replace(/\s/g, '').length)

/** 运行中且本次仍是自动采用：先把「不自动采用」落盘才放行编辑 */
const editLocked = computed(() => rw.runActive.value && rw.currentRun.value?.auto_adopt !== false)

const runFailure = computed(() => (rw.currentRun.value?.status === 'failed'
  ? (rw.currentRun.value.error || rw.strip.value.find(stage => stage.status === 'failed')?.error || '')
  : ''))

const candidate = computed(() => rw.candidateVersion.value)

const stageVersions = computed(() => rw.versionsByStage.value.get(selectedStage.value) || [])
const previewVersion = computed(() => {
  const list = stageVersions.value
  if (!list.length) return null
  const picked = pickedVersion.value[selectedStage.value]
  const chosen = picked ? list.find(version => version.id === picked) : null
  if (chosen) return chosen
  const fromRun = rw.strip.value.find(stage => stage.key === selectedStage.value)?.versionId
  return (fromRun ? list.find(version => version.id === fromRun) : null) || list[0]
})
const predecessorVersion = computed(() => rw.predecessorOf(previewVersion.value))
const isSkipVersion = computed(() => previewVersion.value?.source === 'skip_copy')
const fidelityReport = computed(() => (selectedStage.value === 'fidelity' && !isSkipVersion.value
  ? previewVersion.value?.report || null
  : null))
const overLimitParagraphs = computed(() => (Array.isArray(fidelityReport.value?.over_limit_paragraphs)
  ? fidelityReport.value.over_limit_paragraphs
  : []))
const fidelityWarnings = computed(() => (Array.isArray(fidelityReport.value?.warnings) ? fidelityReport.value.warnings : []))
const deltaPercent = computed(() => {
  const ratio = Number(fidelityReport.value?.delta_ratio)
  return Number.isFinite(ratio) ? (ratio * 100).toFixed(1) : '0.0'
})

/** 最终稿来源：人工保存 / 采用的阶段版本 / 旧数据未记录 */
const finalVersion = computed(() => {
  const id = rw.state.value.current_final_version_id
  return id ? rw.versionById.value.get(id) || null : null
})
const currentServerContent = computed(() => finalVersion.value?.content ?? props.finalContent)
function captureDraftRevision() {
  draftRevision.value = { source_revision: rw.state.value.source_revision, final_revision: rw.state.value.final_revision }
}
watch(() => [rw.state.value.source_revision, rw.state.value.final_revision], () => {
  if (!dirty.value) captureDraftRevision()
})
const finalOriginLabel = computed(() => {
  const version = finalVersion.value
  if (!version) return t('episode.rewrite.originUnknown')
  if (version.stage_key === 'manual') return t('episode.rewrite.originManual', { id: version.id })
  return t('episode.rewrite.originAdopted', {
    name: stageName(version.stage_key),
    run: version.run_id ?? '—',
    id: version.id,
  })
})
const finalState = computed(() => {
  if (finalVersion.value?.stage_key === 'manual') return 'manual_edits'
  if (candidate.value) return 'pending'
  return finalVersion.value ? 'adopted' : 'pending'
})

function stageName(key) {
  const name = `episode.rewrite.stageName.${key}`
  if (te(name)) return t(name)
  return rw.stageDefs.value.find(def => def.key === key)?.label || String(key || '')
}

function selectStage(key) {
  // 最终稿不是预览的一格：点它只是把焦点移到可编辑正文，预览与差异保持原样
  if (key === 'final') { editorEl.value?.focus(); return }
  selectedStage.value = key
  persist()
}
function pickRun(event) {
  const value = event.target.value
  rw.viewRunId.value = value ? Number(value) : null
  pickedVersion.value = {}
}
function pickVersion(event) {
  const id = Number(event.target.value)
  if (id) {
    pickedVersion.value = { ...pickedVersion.value, [selectedStage.value]: id }
    persist()
  }
}

function persist() {
  try {
    localStorage.setItem(storeKey.value, JSON.stringify({
      stage: selectedStage.value,
      versions: pickedVersion.value,
      diffMode: diffMode.value,
    }))
  } catch { /* 静默：记忆位置失败不影响使用 */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey.value) || 'null')
    if (!saved) return
    if (saved.stage) selectedStage.value = saved.stage
    if (saved.versions && typeof saved.versions === 'object') pickedVersion.value = saved.versions
    if (saved.diffMode === 'plain' || saved.diffMode === 'diff') diffMode.value = saved.diffMode
  } catch { /* 静默 */ }
}
watch(diffMode, persist)

// ===== 执行 =====
function modelArgs() {
  return { model: props.chatModel || undefined, config_id: props.chatConfigId || undefined }
}

async function fire(body) {
  // 有未保存草稿时绝不启动会自动采用的运行：结果只作候选
  const res = await rw.start({ ...body, ...modelArgs(), auto_adopt: !dirty.value })
  if (res.ok) {
    toast.success(dirty.value ? t('episode.rewrite.startedManual') : t('episode.rewrite.started'))
    sourceChangePrompt.value = null
    return
  }
  const code = res.error?.error
  if (code === 'source_changed') { sourceChangePrompt.value = body; return }
  if (code === 'run_active') { toast.warning(t('episode.rewrite.error.runActive')); await rw.reload(); return }
  if (code === 'prepared_source_empty') { toast.error(t('episode.rewrite.error.preparedEmpty')); return }
  toast.error(res.message || t('episode.rewrite.error.startFailed'))
}

function runAll() { return fire({}) }
function skipAll() { return fire({ skip_stages: [...rw.stageKeys.value] }) }
function confirmSourceChange() {
  const body = sourceChangePrompt.value
  sourceChangePrompt.value = null
  if (body) return fire({ ...body, acknowledge_source_change: true })
}

/**
 * 从某阶段继续：前驱必须是该阶段**实际的上一阶段**的正式版本，
 * 第一个 AI 阶段没有前驱（用本次冻结的过滤后正文）。
 */
function startFrom(key, skip) {
  const keys = rw.stageKeys.value
  const index = keys.indexOf(key)
  const previous = index > 0 ? keys[index - 1] : null
  const predecessorId = previous
    ? (pickedVersion.value[previous] || rw.versionsByStage.value.get(previous)?.[0]?.id || null)
    : null
  if (previous && !predecessorId) {
    toast.warning(t('episode.rewrite.error.predecessorRequired', { name: stageName(previous) }))
    return
  }
  return fire({
    start_stage: key,
    predecessor_version_id: predecessorId || undefined,
    skip_stages: skip ? [key] : undefined,
  })
}

// ===== 最终稿 =====
async function unlockEditing() {
  if (await rw.disableAutoAdopt()) toast.info(t('episode.rewrite.manualMode'))
  else toast.error(t('episode.rewrite.error.manualFailed'))
}

async function saveFinal() {
  const draft = finalDraft.value
  checking.value = true
  try {
    const result = await inspectDraftForSave(draft, content => scriptRewriteAPI.inspectNarration(props.episodeId, {
      content, config_id: props.chatConfigId || undefined, model: props.chatModel || undefined,
    }))
    if (finalDraft.value !== draft) return
    if (result.failed || result.findings.length) {
      inspection.value = result
      return
    }
    await persistFinal(draft)
  } finally {
    checking.value = false
  }
}

async function finishInspection(remove) {
  const pending = inspection.value
  if (!pending || finalDraft.value !== pending.draft) { inspection.value = null; return }
  const content = applyInspectionChoice(pending, remove)
  inspection.value = null
  finalDraft.value = content
  await persistFinal(content)
}

async function persistFinal(content) {
  const res = await rw.saveFinal(content, draftRevision.value || undefined)
  if (!res.ok) {
    if (!rw.conflict.value) toast.error(res.message || t('episode.rewrite.error.saveFailed'))
    return
  }
  baseline.value = content
  externalChange.value = false
  captureDraftRevision()
  toast.success(res.changed ? t('episode.rewrite.savedToast') : t('episode.rewrite.savedNoChange'))
  emit('refresh')
}

async function adoptVersion(versionId) {
  const res = await rw.adopt(versionId)
  if (!res.ok) {
    if (!rw.conflict.value) toast.error(res.message || t('episode.rewrite.error.adoptFailed'))
    return
  }
  acceptExternal()
  toast.success(res.changed ? t('episode.rewrite.adopted') : t('episode.rewrite.adoptedNoChange'))
  emit('refresh')
}

function applyConflict() {
  const conflict = rw.conflict.value
  if (!conflict) return
  if (conflict.kind === 'adopt' && conflict.versionId) {
    rw.conflict.value = null
    return adoptVersion(conflict.versionId)
  }
  rw.conflict.value = null
  finalDraft.value = conflict.mine
  captureDraftRevision()
  return saveFinal()
}

function compareExternal() {
  rw.conflict.value = { kind: 'save', versionId: null, mine: finalDraft.value, message: t('episode.rewrite.externalChange') }
}
function acceptExternal() {
  finalDraft.value = currentServerContent.value
  baseline.value = currentServerContent.value
  captureDraftRevision()
  externalChange.value = false
}
function keepCurrentFinal() {
  acceptExternal()
  rw.conflict.value = null
  emit('refresh')
}

// 服务端最终稿回流：没有本地改动就跟随；有改动时保留草稿并提示，绝不悄悄覆盖
watch(currentServerContent, (next) => {
  if (next === baseline.value) return
  if (!dirty.value) {
    finalDraft.value = next
    baseline.value = next
    externalChange.value = false
    captureDraftRevision()
    return
  }
  externalChange.value = true
})

watch(() => props.episodeId, () => {
  pickedVersion.value = {}
  rw.viewRunId.value = null
  externalChange.value = false
  finalDraft.value = props.finalContent
  baseline.value = props.finalContent
  restore()
  void rw.reload()
})

// 改写任务结束：阶段版本、采用状态、最终稿都可能变了，同时让页面重载剧集
onTaskFinished((task) => {
  const kind = String(task?.kind || task?.params?.kind || '')
  if (kind !== 'script_rewrite') return
  if (Number(task?.episode_id) !== Number(props.episodeId)) return
  void rw.reload().then(() => emit('refresh'))
})

onMounted(() => {
  restore()
  void rw.reload()
})
</script>

<style scoped>
.rw { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.rw-top {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface-raised);
}
.rw-run { font-size: 11.5px; color: var(--text-2); }
.rw-history { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.rw-history-select { height: 26px; font-size: 11px; padding: 0 6px; }
.rw-error { margin: 0; padding: 6px 12px; font-size: 12px; color: var(--danger-text, #d9534f); }
.rw-hint { margin: 0; padding: 6px 12px; font-size: 11.5px; color: var(--text-2); }
.rw-inspection-dialog { width: 700px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px); display: flex; flex-direction: column; }
.rw-inspection-body { overflow-y: auto; }
.rw-ack {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0;
  padding: 7px 12px; font-size: 12px; color: var(--text-1);
  background: var(--warn-bg); border-bottom: 1px solid var(--warn-border);
}
.rw-body {
  flex: 1; min-height: 0; display: grid; gap: 1px;
  grid-template-columns: 1fr 1.1fr; background: var(--border);
}
/* 1280：上下布局，最终稿保持完整可编辑，差异区可折叠 */
@media (max-width: 1439px) {
  .rw-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(260px, 1fr); overflow-y: auto; }
  .rw-preview { max-height: 46vh; }
  .rw-preview.is-collapsed { max-height: none; }
}
.rw-preview, .rw-final { background: var(--bg-0, var(--surface)); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.rw-sec-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--surface-raised);
}
.rw-sec-title { font-size: 12px; color: var(--text-1); }
.rw-collapse { border: none; background: none; color: var(--text-3); cursor: pointer; font-size: 11px; padding: 0 2px; }
.rw-version-select { height: 24px; font-size: 11px; padding: 0 6px; max-width: 260px; }
.rw-modes { display: flex; gap: 4px; }
.rw-modes .btn.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.rw-preview-body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.rw-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.rw-tag-warn { color: var(--danger-text, #d9534f); }
.rw-plain { margin: 0; font-size: 13px; line-height: 1.95; white-space: pre-wrap; word-break: break-word; color: var(--text-1); }
.rw-empty { margin: 0; font-size: 12.5px; color: var(--text-3); }
.rw-fidelity { display: flex; flex-direction: column; gap: 6px; }
.rw-list { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-2); line-height: 1.7; }
.rw-origin { font-size: 11px; }
.rw-lock {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 12px; font-size: 12px;
  background: var(--warn-bg); border-bottom: 1px solid var(--warn-border);
}
.rw-editor {
  flex: 1; border: none; border-radius: 0; padding: 20px 22px; min-height: 240px;
  font-size: 13.5px; line-height: 1.95; resize: none; outline: none;
  font-family: var(--font-body); background: var(--bg-input); color: var(--text-0);
}
.rw-editor:read-only { background: var(--overlay-track); color: var(--text-2); }
.rw-candidate {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); font-size: 12px;
}
.char-count { font-size: 11px; color: var(--text-3); }
</style>
