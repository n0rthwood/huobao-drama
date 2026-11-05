<template>
  <div class="pip" @click.stop>
    <div class="pip-head">
      <span class="pip-label">{{ t('episode.documentary.pipeline.sectionTitle') }}</span>
      <span v-if="activeRun" class="pip-badge" :class="runStatusClass(activeRun.status)">
        {{ t(`episode.documentary.pipeline.status${cap(activeRun.status)}`) }}
      </span>
      <span v-if="activeRun?.step" class="dim pip-step">{{ t('episode.documentary.pipeline.stepLabel', { step: activeRun.step }) }}</span>
      <select v-model="purpose" class="input pip-select" :disabled="starting">
        <option value="precision">{{ t('episode.documentary.pipeline.purposePrecision') }}</option>
        <option value="beautify">{{ t('episode.documentary.pipeline.purposeBeautify') }}</option>
      </select>
      <button class="pip-toggle" type="button" :disabled="starting" @click.stop="start">
        <Loader2 v-if="starting" :size="11" class="animate-spin" />
        <Play v-else :size="11" />
        {{ starting ? t('episode.documentary.pipeline.starting') : t('episode.documentary.pipeline.start') }}
      </button>
      <button
        v-if="activeRun && (activeRun.status === 'queued' || activeRun.status === 'processing')"
        class="pip-toggle"
        type="button"
        :disabled="cancelling"
        @click.stop="cancel"
      >
        <X :size="11" />
        {{ t('episode.documentary.pipeline.cancel') }}
      </button>
    </div>

    <p class="pip-notice">{{ t('episode.documentary.pipeline.sectionHint') }}</p>
    <p v-if="startError" class="pip-error">{{ startError }}</p>
    <p v-if="loadError" class="pip-error">{{ loadError }}</p>
    <p v-if="detail?.run.error" class="pip-error">{{ t('episode.documentary.pipeline.errorLabel', { msg: detail.run.error }) }}</p>

    <!-- 运行列表：同资产的历史 run，切换只换读，不触发任何生成 -->
    <div v-if="runs.length > 1" class="pip-runs">
      <button
        v-for="run in runs"
        :key="run.id"
        type="button"
        class="pip-run-chip"
        :class="{ on: run.id === selectedRunId }"
        @click.stop="selectRun(run.id)"
      >
        #{{ run.id }} · {{ t(`episode.documentary.pipeline.purpose${cap(run.purpose)}`) }}
      </button>
    </div>

    <!-- 素材 asset_source：全部人工入库，面板绝不自动抓取 -->
    <section class="pip-block">
      <div class="pip-block-head" @click.stop="showSources = !showSources">
        <ChevronDown :size="12" :class="{ 'pip-rot': !showSources }" />
        <strong>{{ t('episode.documentary.pipeline.sourcesTitle') }}</strong>
        <span class="dim">{{ sources.length }}</span>
      </div>
      <template v-if="showSources">
        <p class="pip-note">{{ t('episode.documentary.pipeline.sourcesHint') }}</p>
        <ul v-if="sources.length" class="pip-list">
          <li v-for="source in sources" :key="source.id" class="pip-source">
            <span class="pip-badge" :class="`role-${source.role}`">
              {{ t(`episode.documentary.pipeline.role${roleKey(source.role)}`) }}
            </span>
            <span class="pip-source-main">{{ source.title || source.url || source.local_path }}</span>
            <span class="dim">{{ source.license }}</span>
            <span v-if="source.artist" class="dim">{{ source.artist }}</span>
            <span v-if="source.era" class="dim">{{ source.era }}</span>
            <a v-if="source.url" :href="source.url" target="_blank" rel="noreferrer" class="pip-link">
              {{ t('episode.documentary.pipeline.sourceOpen') }}
            </a>
            <button class="pip-del" type="button" :title="t('episode.documentary.pipeline.sourceDelete')" @click.stop="removeSource(source.id)">
              <X :size="12" />
            </button>
          </li>
        </ul>
        <p v-else class="pip-empty dim">{{ t('episode.documentary.pipeline.sourcesEmpty') }}</p>

        <div class="pip-form">
          <input v-model="form.url" class="input" :placeholder="t('episode.documentary.pipeline.sourceUrl')" />
          <input v-model="form.title" class="input" :placeholder="t('episode.documentary.pipeline.sourceTitleField')" />
          <input v-model="form.license" class="input" :placeholder="t('episode.documentary.pipeline.sourceLicense')" />
          <input v-model="form.artist" class="input" :placeholder="t('episode.documentary.pipeline.sourceArtist')" />
          <input v-model="form.era" class="input" :placeholder="t('episode.documentary.pipeline.sourceEra')" />
          <select v-model="form.role" class="input">
            <option value="generation_reference">{{ t('episode.documentary.pipeline.roleGenerationReference') }}</option>
            <option value="shape_only">{{ t('episode.documentary.pipeline.roleShapeOnly') }}</option>
            <option value="rejected">{{ t('episode.documentary.pipeline.roleRejected') }}</option>
          </select>
          <button class="btn btn-sm btn-primary" type="button" :disabled="adding" @click.stop="addSource">
            {{ adding ? t('episode.documentary.pipeline.sourceAdding') : t('episode.documentary.pipeline.sourceAdd') }}
          </button>
        </div>
        <!-- 本地原件：走 multipart，license/role 等字段与 URL 入库同一套 -->
        <div class="pip-form">
          <label class="pip-file">
            <span>{{ t('episode.documentary.pipeline.sourceFile') }}</span>
            <input ref="fileInput" type="file" accept="image/*,.pdf" @change="onPickFile" />
          </label>
          <span class="dim">{{ pickedFile ? pickedFile.name : t('episode.documentary.pipeline.sourcePickFile') }}</span>
          <button class="btn btn-sm" type="button" :disabled="uploading || !pickedFile" @click.stop="uploadSource">
            {{ uploading ? t('episode.documentary.pipeline.sourceUploading') : t('episode.documentary.pipeline.sourceUpload') }}
          </button>
        </div>
        <p v-if="sourceError" class="pip-error">{{ sourceError }}</p>
      </template>
    </section>

    <!-- 事实表：生成与核验共用的唯一清单 -->
    <section class="pip-block">
      <div class="pip-block-head" @click.stop="showSpec = !showSpec">
        <ChevronDown :size="12" :class="{ 'pip-rot': !showSpec }" />
        <strong>{{ t('episode.documentary.pipeline.specTitle') }}</strong>
        <span v-if="spec" class="dim">{{ t('episode.documentary.pipeline.specVersion', { v: spec.version }) }}</span>
      </div>
      <template v-if="showSpec">
        <p v-if="!spec" class="pip-empty dim">{{ t('episode.documentary.pipeline.specEmpty') }}</p>
        <template v-else>
          <p class="pip-note">{{ spec.summary }}</p>
          <div class="pip-sub">
            <strong>{{ t('episode.documentary.pipeline.specMustHave') }}</strong>
            <ul class="pip-list">
              <li v-for="item in spec.must_have" :key="item.id" class="pip-spec-row">
                <span class="pip-badge">{{ t(`episode.documentary.pipeline.metric${cap(item.metric)}`) }}</span>
                <span class="pip-source-main">{{ item.element }}</span>
                <span class="dim">{{ t('episode.documentary.pipeline.specWhy', { why: item.why }) }}</span>
                <span class="dim">{{ t('episode.documentary.pipeline.specCheck', { check: item.check }) }}</span>
              </li>
            </ul>
          </div>
          <div v-if="spec.forbidden.length" class="pip-sub">
            <strong>{{ t('episode.documentary.pipeline.specForbidden') }}</strong>
            <ul class="pip-list">
              <li v-for="item in spec.forbidden" :key="item.id" class="pip-spec-row">
                <span class="pip-source-main">{{ item.error }}</span>
                <span class="dim">{{ item.why }}</span>
              </li>
            </ul>
          </div>
          <div v-if="spec.tolerances.length" class="pip-sub">
            <strong>{{ t('episode.documentary.pipeline.specTolerances') }}</strong>
            <ul class="pip-list"><li v-for="(x, i) in spec.tolerances" :key="`tol-${i}`" class="dim">{{ x }}</li></ul>
          </div>
          <div v-if="spec.uncertainties.length" class="pip-sub">
            <strong>{{ t('episode.documentary.pipeline.specUncertainties') }}</strong>
            <ul class="pip-list"><li v-for="(x, i) in spec.uncertainties" :key="`unc-${i}`" class="dim">{{ x }}</li></ul>
          </div>
        </template>
      </template>
    </section>

    <!-- 轮次时间线：r0 精确轮，r1/r2 美化轮 -->
    <section class="pip-block">
      <div class="pip-block-head">
        <strong>{{ t('episode.documentary.pipeline.roundsTitle') }}</strong>
      </div>
      <p v-if="!rounds.length" class="pip-empty dim">{{ t('episode.documentary.pipeline.roundsEmpty') }}</p>
      <div v-else class="pip-timeline">
        <button
          v-for="round in rounds"
          :key="round.id"
          type="button"
          class="pip-round-chip"
          :class="{ on: round.id === selectedRoundId }"
          @click.stop="selectedRoundId = round.id"
        >
          <span>{{ t('episode.documentary.pipeline.roundLabel', { n: round.round_no }) }}</span>
          <span class="dim">{{ t(`episode.documentary.pipeline.purpose${cap(round.purpose)}`) }}</span>
          <span class="pip-badge">{{ t(`episode.documentary.pipeline.roundStatus${cap(round.status)}`) }}</span>
          <span class="pip-badge" :class="gateClass(round)">{{ t(`episode.documentary.pipeline.gateBadge${gateKey(round)}`) }}</span>
        </button>
      </div>
    </section>

    <!-- 选中轮：左图右清单 -->
    <section v-if="selectedRound" class="pip-block pip-round">
      <div class="pip-round-grid">
        <div class="pip-round-image">
          <img
            v-if="selectedRound.image_path"
            :src="mediaUrl(selectedRound.image_path)"
            :alt="t('episode.documentary.pipeline.roundImageTitle')"
            @click.stop="openRoundImage(selectedRound)"
          />
          <p v-else class="pip-empty dim">{{ t('episode.documentary.pipeline.roundImageEmpty') }}</p>
          <p v-if="selectedRound.error_msg" class="pip-error">{{ selectedRound.error_msg }}</p>
        </div>

        <div class="pip-round-list">
          <strong>{{ t('episode.documentary.pipeline.checklistTitle') }}</strong>
          <ul class="pip-list">
            <li
              v-for="item in checklist"
              :key="item.id"
              class="pip-check"
              :class="`v-${item.verdict}`"
            >
              <span class="pip-badge">{{ t(`episode.documentary.pipeline.verdict${cap(item.verdict)}`) }}</span>
              <span class="pip-source-main">{{ item.element }}</span>
              <span class="dim">{{ item.evidence || t('episode.documentary.pipeline.evidenceEmpty') }}</span>
            </li>
          </ul>

          <template v-if="selectedRound.gate">
            <strong>{{ t('episode.documentary.pipeline.forbiddenTitle') }}</strong>
            <ul v-if="selectedRound.gate.forbidden_hits.length" class="pip-list">
              <li v-for="hit in selectedRound.gate.forbidden_hits" :key="hit.id" class="pip-check v-violation">
                <span class="pip-badge">{{ t('episode.documentary.pipeline.forbiddenHit') }}</span>
                <span class="pip-source-main">{{ hit.error }}</span>
                <span class="dim">{{ hit.evidence }}</span>
              </li>
            </ul>
            <p v-else class="pip-empty dim">{{ t('episode.documentary.pipeline.forbiddenClear') }}</p>

            <div class="pip-gate">
              <div class="pip-gate-head">
                <strong>{{ t('episode.documentary.pipeline.gateTitle') }}</strong>
                <span class="pip-badge" :class="gateClass(selectedRound)">{{ t(`episode.documentary.pipeline.gateBadge${gateKey(selectedRound)}`) }}</span>
              </div>
              <p class="pip-notice">{{ t('episode.documentary.pipeline.computedNote') }}</p>
              <p>{{ t('episode.documentary.pipeline.gateCoverage', { pct: coveragePct }) }}</p>
              <p v-if="selectedRound.gate.invalid.length">
                {{ t('episode.documentary.pipeline.gateInvalid', { ids: selectedRound.gate.invalid.join('、') }) }}
              </p>
              <p v-else class="dim">{{ t('episode.documentary.pipeline.gateInvalidEmpty') }}</p>
              <p>
                {{ t('episode.documentary.pipeline.textInImage') }}
                <span>{{ textInImageLabel }}</span>
                <span class="dim">{{ selectedRound.gate.text_in_image.evidence }}</span>
              </p>
              <div v-if="selectedRound.gate.locate_checks.length" class="pip-sub">
                <strong>{{ t('episode.documentary.pipeline.locateTitle') }}</strong>
                <ul class="pip-list">
                  <li v-for="lc in selectedRound.gate.locate_checks" :key="lc.id" class="pip-check" :class="lc.status === 'ok' ? 'v-ok' : lc.status === 'off' ? 'v-violation' : 'v-minor'">
                    <span class="pip-badge">{{ t(`episode.documentary.pipeline.locate${pascal(lc.status)}`) }}</span>
                    <span class="pip-source-main">{{ lc.name }}</span>
                    <span class="dim">{{ lc.distance === null ? t('episode.documentary.pipeline.locateDistanceUnknown') : t('episode.documentary.pipeline.locateDistance', { d: lc.distance.toFixed(1) }) }}</span>
                    <span class="dim">{{ lc.detail }}</span>
                  </li>
                </ul>
              </div>
              <p>
                {{ t('episode.documentary.pipeline.semanticsTitle') }}
                <span class="pip-badge">{{ t(`episode.documentary.pipeline.semantics${pascal(selectedRound.gate.semantics_preserved.status)}`) }}</span>
                <span class="dim">{{ selectedRound.gate.semantics_preserved.detail }}</span>
              </p>
            </div>
          </template>
        </div>
      </div>

      <!-- 审批条：没打开过本轮图片就不许审批（审批记录要带 opened 证据） -->
      <div class="pip-approve">
        <div class="pip-approve-head">
          <strong>{{ t('episode.documentary.pipeline.approveTitle') }}</strong>
          <span v-if="awaitingRoundId === selectedRound.id" class="pip-badge gate-await">{{ t('episode.documentary.pipeline.approveAwaiting') }}</span>
          <span v-else class="dim">{{ t('episode.documentary.pipeline.approveNotAwaiting') }}</span>
        </div>
        <p v-if="!openedImages.length" class="pip-notice">{{ t('episode.documentary.pipeline.openedRequired') }}</p>

        <div v-if="violationOptions.length" class="pip-sub">
          <strong>{{ t('episode.documentary.pipeline.selectViolations') }}</strong>
          <label v-for="opt in violationOptions" :key="opt.id" class="pip-chk">
            <input type="checkbox" :value="opt.id" v-model="selectedViolations" />
            <span>{{ opt.label }}</span>
          </label>
        </div>
        <p v-else class="pip-empty dim">{{ t('episode.documentary.pipeline.selectViolationsEmpty') }}</p>

        <label class="pip-field">
          <span>{{ t('episode.documentary.pipeline.notes') }}</span>
          <textarea v-model="notes" class="input" rows="2" :placeholder="t('episode.documentary.pipeline.notesPlaceholder')" />
        </label>

        <label v-if="gateFailed" class="pip-chk">
          <input type="checkbox" v-model="overrideGate" />
          <span>{{ t('episode.documentary.pipeline.overrideGate') }}</span>
        </label>
        <p v-if="gateFailed" class="pip-note dim">{{ t('episode.documentary.pipeline.overrideGateHint') }}</p>

        <div class="pip-approve-actions">
          <button class="btn btn-sm btn-primary" type="button" :disabled="!canApprove" @click.stop="submit('approve')">
            {{ t('episode.documentary.pipeline.approve') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="!canAct" @click.stop="submit('revise')">
            {{ t('episode.documentary.pipeline.revise') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="!canAct" @click.stop="submit('rollback')">
            {{ t('episode.documentary.pipeline.rollback') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="!canAct" @click.stop="submit('abort')">
            {{ t('episode.documentary.pipeline.abort') }}
          </button>
        </div>
        <p v-if="approveError" class="pip-error">{{ approveError }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 资产「精确→美化」流水线面板（Issue #56）。
 *
 * 面板只读闸门结论：coverage / invalid / 画面文字 / 锚点距离一律由后端按事实表算，
 * 模型的自判分数不作数（CONTRACT §B：GateResult 由程序计算）。
 * 审批必须带 opened[]（本轮人确实打开过的图片 path+sha256），否则后端返回 400，
 * 所以这里把「点开过图」记成会话内状态，没点开就禁用审批按钮。
 */
import { ChevronDown, Loader2, Play, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  assetPipelineAPI,
  type AssetPipelineKind,
  type AssetPipelineOpenedImage,
  type AssetPipelineRound,
  type AssetPipelineRunDetail,
  type AssetPipelineRunSummary,
  type AssetSourceRole,
  type AssetSourceRow,
} from '~/composables/useApi'

const { t } = useI18n()

const props = defineProps<{
  assetKind: AssetPipelineKind
  assetId: number
  episodeId: number
  assetName?: string
}>()

const emit = defineEmits<{
  (e: 'preview', url: string, title: string): void
  (e: 'update'): void
}>()

type Verdict = 'approve' | 'revise' | 'rollback' | 'abort'

const runs = ref<AssetPipelineRunSummary[]>([])
const detail = ref<AssetPipelineRunDetail | null>(null)
const selectedRunId = ref<number | null>(null)
const selectedRoundId = ref<number | null>(null)
const loadError = ref('')
const startError = ref('')
const starting = ref(false)
const cancelling = ref(false)
const purpose = ref<'precision' | 'beautify'>('precision')
const showSources = ref(true)
const showSpec = ref(false)
const sources = ref<AssetSourceRow[]>([])
const sourceError = ref('')
const adding = ref(false)
const form = reactive<{ url: string; title: string; license: string; artist: string; era: string; role: AssetSourceRole }>({
  url: '', title: '', license: '', artist: '', era: '', role: 'generation_reference',
})
const uploading = ref(false)
const pickedFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
// opened 契约是「本轮实际打开过的图」：按 round_id 分开存，切轮不能把上一轮的证据带过去
const openedByRound = ref<Record<number, AssetPipelineOpenedImage[]>>({})
const selectedViolations = ref<string[]>([])
const notes = ref('')
const overrideGate = ref(false)
const approveError = ref('')

let timer: ReturnType<typeof setTimeout> | null = null
// 卸载后在途的轮询回来时不能再排下一轮，也不能往已销毁的面板写状态
let stopped = false

function msg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

/** snake_case 状态拼成 i18n 键尾（not_comparable → NotComparable），键名与 locale 文件一一对应 */
function pascal(value: string): string {
  return value.split('_').map(cap).join('')
}

function roleKey(role: AssetSourceRole): string {
  return pascal(role)
}

const activeRun = computed(() => detail.value?.run ?? runs.value.find(r => r.id === selectedRunId.value) ?? null)
const spec = computed(() => detail.value?.spec ?? null)
const rounds = computed(() => detail.value?.rounds ?? [])
const awaitingRoundId = computed(() => detail.value?.awaiting?.round_id ?? null)
const selectedRound = computed(() => rounds.value.find(r => r.id === selectedRoundId.value) ?? rounds.value[rounds.value.length - 1] ?? null)

/** 违规排在最前：人先看要改的，再看通过项 */
const checklist = computed(() => {
  const round = selectedRound.value
  if (!round?.qc) return []
  const byId = new Map(spec.value?.must_have.map(item => [item.id, item.element]) ?? [])
  const rank: Record<string, number> = { violation: 0, minor: 1, ok: 2 }
  return round.qc.verdicts.must_have
    .map(item => ({ id: item.id, verdict: item.verdict, evidence: item.evidence, element: byId.get(item.id) || item.id }))
    .sort((a, b) => (rank[a.verdict] ?? 3) - (rank[b.verdict] ?? 3))
})

const coveragePct = computed(() => Math.round((selectedRound.value?.gate?.coverage ?? 0) * 100))

const textInImageLabel = computed(() => {
  const present = selectedRound.value?.gate?.text_in_image.present
  if (present === true) return t('episode.documentary.pipeline.textPresent')
  if (present === false) return t('episode.documentary.pipeline.textAbsent')
  return t('episode.documentary.pipeline.textUnknown')
})

const violationOptions = computed(() => {
  const gate = selectedRound.value?.gate
  if (!gate) return []
  return [
    ...gate.violations.map(v => ({ id: v.id, label: `${v.element}：${v.evidence}` })),
    ...gate.forbidden_hits.map(v => ({ id: v.id, label: `${v.error}：${v.evidence}` })),
  ]
})

const openedImages = computed<AssetPipelineOpenedImage[]>(() => {
  const round = selectedRound.value
  return round ? openedByRound.value[round.id] ?? [] : []
})

const gateFailed = computed(() => {
  const gate = selectedRound.value?.gate
  return !!gate && !gate.pass
})

const canAct = computed(() => !!selectedRound.value && awaitingRoundId.value === selectedRound.value.id && openedImages.value.length > 0)
// 闸门未过还要通过：必须同时勾「覆盖闸门」并写明理由，否则后端 400
const canApprove = computed(() => canAct.value && (!gateFailed.value || (overrideGate.value && notes.value.trim().length > 0)))

function gateKey(round: AssetPipelineRound): string {
  if (!round.gate) return awaitingRoundId.value === round.id ? 'Awaiting' : 'Incomplete'
  if (round.gate.invalid.length) return 'Incomplete'
  return round.gate.pass ? 'Pass' : 'Fail'
}

function gateClass(round: AssetPipelineRound): string {
  const key = gateKey(round)
  return key === 'Pass' ? 'gate-pass' : key === 'Fail' ? 'gate-fail' : key === 'Awaiting' ? 'gate-await' : 'gate-incomplete'
}

function runStatusClass(status: string): string {
  return status === 'completed' ? 'gate-pass' : status === 'failed' || status === 'cancelled' ? 'gate-fail' : 'gate-await'
}

function openRoundImage(round: AssetPipelineRound) {
  if (!round.image_path) return
  const path = round.image_path
  const sha = round.image_sha256 || ''
  const current = openedByRound.value[round.id] ?? []
  if (!current.some(item => item.path === path && item.sha256 === sha)) {
    openedByRound.value = { ...openedByRound.value, [round.id]: [...current, { path, sha256: sha }] }
  }
  emit('preview', mediaUrl(path), props.assetName || t('episode.documentary.pipeline.roundImageTitle'))
}

function stopPoll() {
  if (timer) { clearTimeout(timer); timer = null }
}

function schedulePoll() {
  stopPoll()
  const run = detail.value?.run
  if (!run || stopped) return
  const busy = run.status === 'queued' || run.status === 'processing'
  if (!busy || detail.value?.awaiting) return
  timer = setTimeout(() => { timer = null; void loadDetail(run.id, true) }, 3000)
}

async function loadRuns() {
  loadError.value = ''
  try {
    const res = await assetPipelineAPI.list(props.assetKind, props.assetId)
    if (stopped) return
    runs.value = res?.runs ?? []
    if (runs.value.length && !runs.value.some(r => r.id === selectedRunId.value)) {
      selectedRunId.value = runs.value[0].id
    }
    if (selectedRunId.value) await loadDetail(selectedRunId.value)
  } catch (err) {
    if (!stopped) loadError.value = msg(err, t('episode.documentary.pipeline.loadFailed'))
  }
}

async function loadDetail(runId: number, silent = false) {
  try {
    const res = await assetPipelineAPI.detail(runId)
    if (stopped) return
    detail.value = res
    sources.value = res?.sources ?? sources.value
    const list = res?.rounds ?? []
    const awaiting = res?.awaiting?.round_id ?? null
    if (!list.some(r => r.id === selectedRoundId.value)) {
      selectedRoundId.value = awaiting ?? (list.length ? list[list.length - 1].id : null)
    }
    schedulePoll()
  } catch (err) {
    if (!stopped && !silent) loadError.value = msg(err, t('episode.documentary.pipeline.loadFailed'))
  }
}

async function loadSources() {
  try {
    const res = await assetPipelineAPI.listSources(props.assetKind, props.assetId)
    if (!stopped) sources.value = res?.sources ?? []
  } catch (err) {
    if (!stopped) sourceError.value = msg(err, t('episode.documentary.pipeline.loadFailed'))
  }
}

function selectRun(runId: number) {
  selectedRunId.value = runId
  selectedRoundId.value = null
  openedByRound.value = {}
  void loadDetail(runId)
}

async function start() {
  if (starting.value) return
  starting.value = true
  startError.value = ''
  try {
    await assetPipelineAPI.start({
      asset_kind: props.assetKind,
      asset_id: props.assetId,
      episode_id: Number(props.episodeId),
      purpose: purpose.value,
    })
    if (stopped) return
    toast.success(t('episode.documentary.pipeline.started'))
    selectedRunId.value = null
    await loadRuns()
    emit('update')
  } catch (err) {
    // 409 = 同资产已有活跃 run，提示去看那一条，不重复起
    const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined
    startError.value = status === 409
      ? t('episode.documentary.pipeline.conflict')
      : msg(err, t('episode.documentary.pipeline.startFailed'))
  } finally {
    if (!stopped) starting.value = false
  }
}

async function cancel() {
  const run = detail.value?.run
  if (!run || cancelling.value) return
  cancelling.value = true
  try {
    await assetPipelineAPI.cancel(run.id)
    if (stopped) return
    toast.success(t('episode.documentary.pipeline.cancelled'))
    await loadRuns()
  } catch (err) {
    if (!stopped) loadError.value = msg(err, t('episode.documentary.pipeline.cancelFailed'))
  } finally {
    if (!stopped) cancelling.value = false
  }
}

async function addSource() {
  if (adding.value) return
  if (!form.license.trim()) {
    sourceError.value = t('episode.documentary.pipeline.sourceLicenseRequired')
    return
  }
  adding.value = true
  sourceError.value = ''
  try {
    await assetPipelineAPI.addSource({
      asset_kind: props.assetKind,
      asset_id: props.assetId,
      url: form.url.trim() || undefined,
      title: form.title.trim() || undefined,
      artist: form.artist.trim() || undefined,
      era: form.era.trim() || undefined,
      license: form.license.trim(),
      role: form.role,
    })
    if (stopped) return
    form.url = ''
    form.title = ''
    form.artist = ''
    form.era = ''
    toast.success(t('episode.documentary.pipeline.sourceAdded'))
    await loadSources()
  } catch (err) {
    if (!stopped) sourceError.value = msg(err, t('episode.documentary.pipeline.sourceAddFailed'))
  } finally {
    if (!stopped) adding.value = false
  }
}

function onPickFile(event: Event) {
  const target = event.target
  pickedFile.value = target instanceof HTMLInputElement ? target.files?.[0] ?? null : null
}

async function uploadSource() {
  const file = pickedFile.value
  if (uploading.value || !file) return
  if (!form.license.trim()) {
    sourceError.value = t('episode.documentary.pipeline.sourceLicenseRequired')
    return
  }
  uploading.value = true
  sourceError.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('asset_kind', props.assetKind)
    fd.append('asset_id', String(props.assetId))
    fd.append('license', form.license.trim())
    fd.append('role', form.role)
    if (form.title.trim()) fd.append('title', form.title.trim())
    if (form.artist.trim()) fd.append('artist', form.artist.trim())
    if (form.era.trim()) fd.append('era', form.era.trim())
    await assetPipelineAPI.uploadSource(fd)
    if (stopped) return
    pickedFile.value = null
    // 同一个文件再选一次也要触发 change，所以显式清空 input 的值
    if (fileInput.value) fileInput.value.value = ''
    form.title = ''
    form.artist = ''
    form.era = ''
    toast.success(t('episode.documentary.pipeline.sourceAdded'))
    await loadSources()
  } catch (err) {
    if (!stopped) sourceError.value = msg(err, t('episode.documentary.pipeline.sourceAddFailed'))
  } finally {
    if (!stopped) uploading.value = false
  }
}

async function removeSource(sourceId: number) {
  sourceError.value = ''
  try {
    await assetPipelineAPI.deleteSource(sourceId)
    if (!stopped) await loadSources()
  } catch (err) {
    if (!stopped) sourceError.value = msg(err, t('episode.documentary.pipeline.sourceDeleteFailed'))
  }
}

async function submit(verdict: Verdict) {
  const run = detail.value?.run
  const round = selectedRound.value
  if (!run || !round || !openedImages.value.length) return
  if (verdict === 'approve' && !canApprove.value) return
  approveError.value = ''
  try {
    await assetPipelineAPI.approve(run.id, {
      round_id: round.id,
      verdict,
      selected_violations: selectedViolations.value.length ? [...selectedViolations.value] : undefined,
      notes: notes.value.trim() || undefined,
      opened: [...openedImages.value],
      override_gate: verdict === 'approve' && gateFailed.value ? true : undefined,
    })
    if (stopped) return
    toast.success(t('episode.documentary.pipeline.approveDone'))
    selectedViolations.value = []
    notes.value = ''
    overrideGate.value = false
    await loadDetail(run.id)
    emit('update')
  } catch (err) {
    if (!stopped) approveError.value = msg(err, t('episode.documentary.pipeline.approveFailed'))
  }
}

watch(() => [props.assetKind, props.assetId], () => {
  stopPoll()
  detail.value = null
  runs.value = []
  selectedRunId.value = null
  selectedRoundId.value = null
  openedByRound.value = {}
  void loadRuns()
  void loadSources()
})

// 切轮次等于换审批对象：上一轮的勾选与理由不能带过去
watch(selectedRoundId, () => {
  selectedViolations.value = []
  overrideGate.value = false
  approveError.value = ''
})

onMounted(() => { void loadRuns(); void loadSources() })
onBeforeUnmount(() => { stopped = true; stopPoll() })
</script>

<style scoped>
.pip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pip-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.pip-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
}
.pip-step { font-size: 10.5px; }
.pip-select { width: auto; min-width: 96px; font-size: 10.5px; }
.pip-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.pip-toggle:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.pip-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.pip-notice {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.pip-note { margin: 0; font-size: 10.5px; color: var(--text-2); }
.pip-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.pip-empty { margin: 0; font-size: 10.5px; }
.pip-runs { display: flex; flex-wrap: wrap; gap: 4px; }
.pip-run-chip,
.pip-round-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.pip-run-chip.on,
.pip-round-chip.on { border-color: var(--accent-text); color: var(--accent-text); }
.pip-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}
.pip-block-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-1);
  cursor: pointer;
}
.pip-rot { transform: rotate(-90deg); }
.pip-sub { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-1); }
.pip-list {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10.5px;
}
.pip-source,
.pip-spec-row,
.pip-check {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
}
.pip-source-main { flex: 1 1 160px; min-width: 0; color: var(--text-1); }
.pip-link { color: var(--accent-text); font-size: 10.5px; }
.pip-badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  font: 600 10px var(--font-body);
  color: var(--text-2);
}
.pip-badge.role-rejected { border-color: var(--action-danger); color: var(--action-danger); }
.pip-badge.gate-pass { border-color: #4caf50; color: #4caf50; }
.pip-badge.gate-fail { border-color: var(--action-danger); color: var(--action-danger); }
.pip-badge.gate-incomplete,
.pip-badge.gate-await { border-color: #d98324; color: #d98324; }
.pip-check.v-ok { border-color: color-mix(in srgb, #4caf50 55%, var(--border)); }
.pip-check.v-minor { border-color: #d98324; }
.pip-check.v-violation { border-color: var(--action-danger); background: color-mix(in srgb, var(--action-danger) 8%, var(--surface-soft)); }
.pip-del {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
/* 与 PropSemanticsPanel .sem-del:hover 同口径：危险底色上固定用白字 */
.pip-del:hover { background: var(--action-danger); color: #fff; }
.pip-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 4px;
  align-items: center;
}
.pip-file { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); font-size: 10.5px; }
.pip-file input[type="file"] { max-width: 150px; font-size: 10px; }
.pip-timeline { display: flex; flex-wrap: wrap; gap: 6px; }
.pip-round-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.4fr);
  gap: 8px;
}
.pip-round-image img {
  width: 100%;
  max-height: 320px;
  aspect-ratio: 4 / 3;
  object-fit: contain;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: zoom-in;
}
.pip-round-list { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; }
.pip-gate { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-2); }
.pip-gate p { margin: 0; }
.pip-gate-head { display: flex; align-items: center; gap: 6px; color: var(--text-1); }
.pip-approve {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 10.5px;
}
.pip-approve-head { display: flex; align-items: center; gap: 6px; color: var(--text-1); }
.pip-approve-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.pip-chk { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); }
.pip-field { display: flex; flex-direction: column; gap: 3px; color: var(--text-2); }
</style>
