<template>
  <div class="nedit">
    <!-- 工具条：所有标记都通过弹窗选择后插入，用户不需要手写源写法 -->
    <div class="nedit-toolbar">
      <button type="button" class="btn btn-sm" :disabled="disabled" :title="t('episode.narrationEditor.pronTitle')" @mousedown.prevent @click="openPron()">
        {{ t('episode.narrationEditor.pron') }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="disabled" :title="t('episode.narrationEditor.checkTitle')" @mousedown.prevent @click="openCheck">
        {{ t('episode.narrationEditor.check') }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="disabled" @mousedown.prevent @click="openTone()">
        {{ t('episode.narrationEditor.tone') }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="disabled" @mousedown.prevent @click="openPause()">
        {{ t('episode.narrationEditor.pause') }}
      </button>
      <span class="nedit-tip">{{ t('episode.narrationEditor.tip') }}</span>
    </div>

    <div class="nedit-area">
      <div ref="backdropEl" class="textarea nedit-backdrop" aria-hidden="true">
        <div class="nedit-backdrop-content" v-html="highlightedHtml"></div>
      </div>
      <textarea
        ref="taEl"
        class="textarea nedit-input"
        :rows="rows"
        :value="text"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="onInput"
        @blur="onBlur"
        @click="updateCaret"
        @keyup="updateCaret"
        @scroll="syncScroll"
      />
    </div>

    <!-- 光标落在某个标记里：直接编辑 / 删除，不用碰源写法 -->
    <div v-if="caretMarker" class="nedit-markerbar">
      <span :class="['nedit-chip', `is-${caretMarker.type}`]">{{ markerLabel(caretMarker) }}</span>
      <span v-if="caretMarker.type === 'invalid'" class="nedit-error">{{ caretMarker.error }}</span>
      <button type="button" class="btn btn-sm" @mousedown.prevent @click="editMarker(caretMarker)">{{ t('episode.narrationEditor.edit') }}</button>
      <button type="button" class="btn btn-sm" @mousedown.prevent @click="removeMarker(caretMarker)">{{ t('episode.narrationEditor.remove') }}</button>
    </div>

    <div v-if="hasMarkers" class="nedit-preview">
      <span class="nedit-preview-label">{{ t('episode.narrationEditor.subtitlePreview') }}</span>
      <span class="nedit-preview-text">{{ subtitle }}</span>
    </div>
    <ul v-if="parsed.errors.length" class="nedit-errors">
      <li v-for="(e, i) in parsed.errors" :key="i">{{ e.message }}</li>
    </ul>

    <!-- 注音 -->
    <Teleport to="body">
      <div v-if="pron.open" class="overlay nedit-overlay" @click.self="pron.open = false">
        <div class="dialog nedit-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.narrationEditor.pronDialog', { word: pron.base })">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.narrationEditor.pronDialog', { word: pron.base }) }}</h2>
            <button class="btn btn-ghost btn-icon" @click="pron.open = false"><X :size="14" /></button>
          </header>
          <div class="dialog-body nedit-body">
            <div class="nedit-modes" role="tablist">
              <button type="button" :class="['btn btn-sm', { 'is-on': pron.mode === 'pinyin' }]" :aria-pressed="pron.mode === 'pinyin'" @click="pron.mode = 'pinyin'">
                {{ t('episode.narrationEditor.modePinyin') }}
              </button>
              <button type="button" :class="['btn btn-sm', { 'is-on': pron.mode === 'homophone' }]" :aria-pressed="pron.mode === 'homophone'" @click="pron.mode = 'homophone'">
                {{ t('episode.narrationEditor.modeHomophone') }}
              </button>
            </div>
            <template v-if="pron.mode === 'pinyin'">
              <div v-for="(row, i) in pron.rows" :key="i" class="nedit-pron-row">
                <div class="nedit-pron-char">{{ row.char }}</div>
                <div class="nedit-pron-opts">
                  <div class="nedit-cands">
                    <button
                      v-for="c in row.candidates"
                      :key="c.py"
                      type="button"
                      :class="['nedit-cand', { 'is-on': row.value === c.py }]"
                      :aria-pressed="row.value === c.py"
                      @click="row.value = c.py"
                    >
                      <strong>{{ c.mark }}</strong>
                      <span v-if="c.example" class="dim">{{ c.example }}</span>
                    </button>
                  </div>
                  <input v-model.trim="row.value" class="input nedit-py-input" :placeholder="t('episode.narrationEditor.pinyinPlaceholder')" />
                  <span v-if="row.neutralOnly" class="nedit-hint">{{ t('episode.narrationEditor.neutralOnly') }}</span>
                </div>
              </div>
              <p class="nedit-hint">{{ t('episode.narrationEditor.pinyinHint') }}</p>
            </template>
            <template v-else>
              <label class="nedit-field">
                <span>{{ t('episode.narrationEditor.homophoneLabel', { n: [...pron.base].length }) }}</span>
                <input v-model.trim="pron.homophone" class="input" :placeholder="t('episode.narrationEditor.homophonePlaceholder')" />
              </label>
              <p class="nedit-hint">{{ t('episode.narrationEditor.homophoneHint') }}</p>
            </template>
            <p v-if="pron.stale" class="nedit-error">{{ t('deeplink.staleRange') }}</p>
            <p v-if="pronError && !pron.stale" class="nedit-error">{{ pronError }}</p>
          </div>
          <footer class="dialog-foot">
            <button v-if="pron.editing" class="btn" @click="removeMarker(pron.editing); pron.open = false">{{ t('episode.narrationEditor.remove') }}</button>
            <span class="ml-auto" />
            <button class="btn" @click="pron.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="pron.stale || !!pronError" @click="confirmPron">{{ t('episode.narrationEditor.insert') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 语气 -->
    <Teleport to="body">
      <div v-if="tone.open" class="overlay nedit-overlay" @click.self="tone.open = false">
        <div class="dialog nedit-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.narrationEditor.toneDialog')">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.narrationEditor.toneDialog') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="tone.open = false"><X :size="14" /></button>
          </header>
          <div class="dialog-body nedit-body">
            <div v-for="g in toneGroups" :key="g.group" class="nedit-tone-group">
              <span v-if="g.group" class="nedit-group-label">{{ g.group }}</span>
              <div class="nedit-cands">
                <button
                  v-for="opt in g.tones"
                  :key="opt.tag"
                  type="button"
                  :class="['nedit-cand', { 'is-on': tone.value === opt.tag }]"
                  :aria-pressed="tone.value === opt.tag"
                  @click="tone.value = opt.tag"
                >{{ opt.label }}</button>
              </div>
            </div>
            <p v-if="tone.stale" class="nedit-error">{{ t('deeplink.staleRange') }}</p>
            <p class="nedit-hint">{{ t('episode.narrationEditor.toneHint') }}</p>
          </div>
          <footer class="dialog-foot">
            <button v-if="tone.editing" class="btn" @click="removeMarker(tone.editing); tone.open = false">{{ t('episode.narrationEditor.remove') }}</button>
            <span class="ml-auto" />
            <button class="btn" @click="tone.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="tone.stale || !tone.value" @click="confirmTone">{{ t('episode.narrationEditor.insert') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 停顿 -->
    <Teleport to="body">
      <div v-if="pause.open" class="overlay nedit-overlay" @click.self="pause.open = false">
        <div class="dialog nedit-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.narrationEditor.pauseDialog')">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.narrationEditor.pauseDialog') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="pause.open = false"><X :size="14" /></button>
          </header>
          <div class="dialog-body nedit-body">
            <template v-if="!pause.editing">
              <span class="nedit-group-label">{{ t('episode.narrationEditor.pauseNatural') }}</span>
              <div class="nedit-cands">
                <button v-for="p in NATURAL_PAUSES" :key="p.ins" type="button" class="nedit-cand" :disabled="pause.stale" :title="t(p.tip)" @click="insertNatural(p.ins)">
                  <strong>{{ p.ins }}</strong> <span class="dim">{{ t(p.label) }}</span>
                </button>
              </div>
              <p class="nedit-hint">{{ t('episode.narrationEditor.pauseNaturalHint') }}</p>
            </template>
            <span class="nedit-group-label">{{ t('episode.narrationEditor.pauseExact') }}</span>
            <div class="nedit-cands">
              <button
                v-for="s in pausePresets"
                :key="s"
                type="button"
                :class="['nedit-cand', { 'is-on': Number(pause.seconds) === s }]"
                :aria-pressed="Number(pause.seconds) === s"
                @click="pause.seconds = s"
              >{{ t('episode.narrationEditor.seconds', { n: s }) }}</button>
            </div>
            <label class="nedit-field">
              <span>{{ t('episode.narrationEditor.pauseCustom', { min: pauseRange.min, max: pauseRange.max }) }}</span>
              <input v-model.number="pause.seconds" class="input nedit-seconds" type="number" :min="pauseRange.min" :max="pauseRange.max" step="0.1" />
            </label>
            <p class="nedit-hint">{{ t('episode.narrationEditor.pauseExactHint') }}</p>
            <p v-if="pause.stale" class="nedit-error">{{ t('deeplink.staleRange') }}</p>
            <p v-if="pauseError && !pause.stale" class="nedit-error">{{ pauseError }}</p>
          </div>
          <footer class="dialog-foot">
            <button v-if="pause.editing" class="btn" @click="removeMarker(pause.editing); pause.open = false">{{ t('episode.narrationEditor.remove') }}</button>
            <span class="ml-auto" />
            <button class="btn" @click="pause.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="pause.stale || !!pauseError" @click="confirmPause">{{ t('episode.narrationEditor.insert') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 多音字检查 -->
    <Teleport to="body">
      <div v-if="check.open" class="overlay nedit-overlay" @click.self="check.open = false">
        <div class="dialog nedit-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.narrationEditor.checkDialog')">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.narrationEditor.checkDialog') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="check.open = false"><X :size="14" /></button>
          </header>
          <div class="dialog-body nedit-body">
            <div v-if="check.loading" class="nedit-hint">{{ t('episode.narrationEditor.checkLoading') }}</div>
            <p v-else-if="!check.items.length" class="nedit-hint">{{ t('episode.narrationEditor.checkNone') }}</p>
            <button
              v-for="item in check.items"
              v-else
              :key="item.index"
              type="button"
              class="nedit-check-row"
              @click="check.open = false; openPron({ start: item.index, end: item.index + 1 })"
            >
              <span class="nedit-check-ctx">{{ item.before }}<mark>{{ item.char }}</mark>{{ item.after }}</span>
              <span class="dim">{{ t('episode.narrationEditor.checkDefault', { py: item.defaultMark, all: item.readings }) }}</span>
            </button>
            <p class="nedit-hint">{{ t('episode.narrationEditor.checkHint') }}</p>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="check.open = false">{{ t('common.close') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
/**
 * 旁白编辑器（#38）：在普通文本框上叠一层高亮，所有发音标记都经弹窗选择后插入。
 * 源写法见 utils/narrationMarkup.js；保存的是带标记的源文本，字幕/字数只用去掉标记的纯文字。
 * 事件：input = 内容变化（父级标「未保存」），commit = 需要保存（失焦，或弹窗插入/删除标记后立即保存）。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { episodeAPI } from '~/composables/useApi'
import {
  CJK_CHAR,
  PAUSE_MAX_SECONDS,
  PAUSE_MIN_SECONDS,
  TONE_TAGS,
  markerAt,
  normalizeSyllable,
  parseNarrationMarkup,
  pauseMarker,
  rubyMarker,
  spokenText,
  toneMarker,
} from '~/utils/narrationMarkup'
import { DEEPLINK_KEYS, querySingle, useDeeplink } from '~/composables/useQuerySync'

const props = defineProps({
  modelValue: { type: String, default: '' },
  episodeId: { type: Number, default: 0 },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 4 },
  disabled: { type: Boolean, default: false },
  // deeplink（#86）：同一集会有多个编辑器实例，用所属分镜 id 区分；为 0 时不发布也不恢复
  deeplinkId: { type: Number, default: 0 },
})
const emit = defineEmits(['input', 'commit'])
const { t } = useI18n()

const NATURAL_PAUSES = [
  { ins: '，', label: 'episode.narrationEditor.pauseComma', tip: 'episode.narrationEditor.pauseCommaTip' },
  { ins: '。', label: 'episode.narrationEditor.pausePeriod', tip: 'episode.narrationEditor.pausePeriodTip' },
  { ins: '……', label: 'episode.narrationEditor.pauseEllipsis', tip: 'episode.narrationEditor.pauseEllipsisTip' },
]

const taEl = ref(null)
const backdropEl = ref(null)
const text = ref(props.modelValue || '')
const caret = ref(0)

watch(() => props.modelValue, (v) => {
  if ((v || '') !== text.value) text.value = v || ''
  nextTick(autoGrow)
})
onMounted(() => nextTick(autoGrow))

const parsed = computed(() => parseNarrationMarkup(text.value))
const hasMarkers = computed(() => parsed.value.segments.some(s => s.type !== 'text'))
const subtitle = computed(() => spokenText(text.value))
const caretMarker = computed(() => markerAt(text.value, caret.value))

// ---------- 目录（语气名 / 常见多音字例词），取不到就用内置语气 ----------
const catalog = ref(null)
async function loadCatalog() {
  if (catalog.value || !props.episodeId) return catalog.value
  try {
    catalog.value = await episodeAPI.narrationMarkupCatalog(props.episodeId)
  } catch {
    catalog.value = null
  }
  return catalog.value
}
const tones = computed(() => catalog.value?.tones?.length ? catalog.value.tones : TONE_TAGS.map(x => ({ ...x, group: '' })))
const toneGroups = computed(() => {
  const groups = []
  for (const tone of tones.value) {
    let g = groups.find(x => x.group === tone.group)
    if (!g) groups.push(g = { group: tone.group, tones: [] })
    g.tones.push(tone)
  }
  return groups
})
const pauseRange = computed(() => catalog.value?.pause || { min: PAUSE_MIN_SECONDS, max: PAUSE_MAX_SECONDS })
const pausePresets = computed(() => catalog.value?.pause?.presets || [0.3, 0.5, 1, 2])

// pinyin-pro 体积较大，用到注音时才加载
let pinyinMod = null
async function loadPinyin() {
  pinyinMod ??= await import('pinyin-pro')
  return pinyinMod
}

// ---------- 高亮镜像层 ----------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
const highlightedHtml = computed(() => {
  let html = parsed.value.segments.map((s) => {
    const raw = escapeHtml(s.type === 'text' ? s.text : s.raw)
    return s.type === 'text' ? raw : `<span class="nedit-token is-${s.type}">${raw}</span>`
  }).join('')
  if (html.endsWith('\n')) html += '\u200b'
  return html
})

function markerLabel(seg) {
  if (seg.type === 'ruby') {
    return seg.kind === 'pinyin'
      ? t('episode.narrationEditor.labelPinyin', { base: seg.base, reading: seg.reading })
      : t('episode.narrationEditor.labelHomophone', { base: seg.base, reading: seg.reading })
  }
  if (seg.type === 'pause') return t('episode.narrationEditor.labelPause', { n: seg.seconds })
  if (seg.type === 'tone') return t('episode.narrationEditor.labelTone', { name: tones.value.find(x => x.tag === seg.tag)?.label || seg.tag })
  return t('episode.narrationEditor.labelInvalid', { raw: seg.raw })
}

// ---------- 文本框 ----------
function autoGrow() {
  const ta = taEl.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}
function syncScroll() {
  if (backdropEl.value && taEl.value) backdropEl.value.scrollTop = taEl.value.scrollTop
}
function updateCaret() {
  caret.value = taEl.value?.selectionStart ?? 0
}
function onInput(e) {
  text.value = e.target.value
  updateCaret()
  emit('input', text.value)
  autoGrow()
}
function onBlur(e) {
  emit('commit', e.target.value)
}

/** 把 [start, end) 换成 str，光标放到插入内容之后，并立即保存 */
function replaceRange(start, end, str) {
  const next = text.value.slice(0, start) + str + text.value.slice(end)
  text.value = next
  emit('input', next)
  emit('commit', next)
  nextTick(() => {
    const ta = taEl.value
    if (!ta) return
    const p = start + str.length
    ta.focus()
    ta.setSelectionRange(p, p)
    caret.value = p
    autoGrow()
  })
}
function selection() {
  const ta = taEl.value
  return { start: ta?.selectionStart ?? text.value.length, end: ta?.selectionEnd ?? text.value.length }
}
/** 插入点不能落在标记中间：落在标记里就挪到标记之后 */
function safeInsertPos(pos) {
  const seg = markerAt(text.value, pos)
  return seg ? seg.end : pos
}

function removeMarker(seg) {
  const restore = seg.type === 'ruby' || seg.type === 'invalid' ? (seg.base || '') : ''
  replaceRange(seg.start, seg.end, restore)
}
function editMarker(seg) {
  if (seg.type === 'ruby' || seg.type === 'invalid') openPron({ start: seg.start, end: seg.end }, seg)
  else if (seg.type === 'pause') openPause(seg)
  else if (seg.type === 'tone') openTone(seg)
}

// ---------- 注音 ----------
// stale = 从链接恢复但位置与已保存正文对不上：只读展示，禁止提交（见 openStale）
const pron = reactive({ open: false, start: 0, end: 0, base: '', mode: 'pinyin', rows: [], homophone: '', editing: null, stale: false })

const pronMarker = computed(() => {
  if (pron.mode === 'homophone') return rubyMarker(pron.base, pron.homophone)
  return rubyMarker(pron.base, pron.rows.map(r => r.value).join(' '))
})
const pronError = computed(() => {
  if (!pron.open) return ''
  if (pron.mode === 'pinyin') {
    const empty = pron.rows.find(r => !r.value)
    if (empty) return t('episode.narrationEditor.pinyinMissing', { char: empty.char })
  } else if (!pron.homophone) {
    return t('episode.narrationEditor.homophoneMissing')
  }
  return parseNarrationMarkup(pronMarker.value).errors[0]?.message || ''
})

function toneMark(py) {
  const m = /^([a-zv]+)([1-4])$/.exec(py)
  if (!m) return py
  const marks = { a: 'āáǎà', o: 'ōóǒò', e: 'ēéěè', i: 'īíǐì', u: 'ūúǔù', v: 'ǖǘǚǜ' }
  const s = m[1]
  const tone = Number(m[2]) - 1
  // 标调规则：a/e 优先，ou 标 o，否则标最后一个元音
  let idx = s.search(/[ae]/)
  if (idx < 0) idx = s.indexOf('ou')
  if (idx < 0) {
    for (let i = s.length - 1; i >= 0; i--) if ('iouv'.includes(s[i])) { idx = i; break }
  }
  if (idx < 0) return py
  return (s.slice(0, idx) + marks[s[idx]][tone] + s.slice(idx + 1)).replace('v', 'ü')
}

/**
 * range：要注音的源文本区间（不传 = 当前选区；没选中取光标前一个字）。
 * editing：正在编辑的已有注音标记（预填它的读音）。
 */
async function openPron(range, editing = null) {
  let { start, end } = range || selection()
  let base
  if (editing) {
    base = editing.base
  } else {
    const inMarker = markerAt(text.value, start) || markerAt(text.value, end - 1 > start ? end - 1 : end)
    if (inMarker) {
      if (inMarker.type === 'ruby' || inMarker.type === 'invalid') return openPron({ start: inMarker.start, end: inMarker.end }, inMarker)
      toast.error(t('episode.narrationEditor.selectInsideMarker'))
      return
    }
    if (start === end && start > 0 && CJK_CHAR.test(text.value[start - 1])) start -= 1
    base = text.value.slice(start, end)
    if (!base || ![...base].every(ch => CJK_CHAR.test(ch))) {
      toast.error(t('episode.narrationEditor.selectChinese'))
      return
    }
  }
  const [{ pinyin, polyphonic }] = await Promise.all([loadPinyin(), loadCatalog()])
  const chars = [...base]
  // 默认读音 = 按整词上下文给出的读音（pinyin-pro 词级判断），已有注音时预填原读音
  const contextual = pinyin(base, { type: 'array', toneType: 'num' })
  const existing = editing?.kind === 'pinyin' ? editing.reading.split(' ') : []
  const studio = catalog.value?.polyphones || {}
  pron.rows = chars.map((char, i) => {
    const all = (polyphonic(char, { type: 'array', toneType: 'num' })[0] || [])
    const valid = [...new Set(all.filter(py => /[1-4]$/.test(py)))]
    const examples = Object.fromEntries((studio[char] || []).map(([py, ex]) => [py, ex]))
    const fallback = /[1-4]$/.test(contextual[i] || '') ? contextual[i] : (valid[0] || '')
    return {
      char,
      candidates: valid.map(py => ({ py, mark: toneMark(py), example: examples[py] || '' })),
      neutralOnly: !valid.length,
      value: existing[i] || fallback,
    }
  })
  pron.start = start
  pron.end = end
  pron.base = base
  pron.editing = editing
  pron.mode = editing?.kind === 'homophone' ? 'homophone' : 'pinyin'
  pron.homophone = editing?.kind === 'homophone' ? editing.reading : ''
  pron.stale = false
  pron.open = true
}
function confirmPron() {
  if (pron.stale || pronError.value) return
  const normalized = pron.mode === 'pinyin'
    ? rubyMarker(pron.base, pron.rows.map(r => normalizeSyllable(r.value).value).join(' '))
    : pronMarker.value
  replaceRange(pron.start, pron.end, normalized)
  pron.open = false
}

// ---------- 语气 ----------
const tone = reactive({ open: false, value: '', pos: 0, editing: null, stale: false })
async function openTone(editing = null) {
  await loadCatalog()
  tone.editing = editing
  tone.value = editing?.tag || ''
  tone.pos = editing ? editing.start : safeInsertPos(selection().start)
  tone.stale = false
  tone.open = true
}
function confirmTone() {
  if (tone.stale || !tone.value) return
  if (tone.editing) replaceRange(tone.editing.start, tone.editing.end, toneMarker(tone.value))
  else replaceRange(tone.pos, tone.pos, toneMarker(tone.value))
  tone.open = false
}

// ---------- 停顿 ----------
const pause = reactive({ open: false, seconds: 1, pos: 0, editing: null, stale: false })
const pauseError = computed(() => {
  const s = Number(pause.seconds)
  if (!Number.isFinite(s) || s < pauseRange.value.min || s > pauseRange.value.max) {
    return t('episode.narrationEditor.pauseRange', { min: pauseRange.value.min, max: pauseRange.value.max })
  }
  return ''
})
async function openPause(editing = null) {
  await loadCatalog()
  pause.editing = editing
  pause.seconds = editing?.seconds ?? 1
  pause.pos = editing ? editing.start : safeInsertPos(selection().start)
  pause.stale = false
  pause.open = true
}
function insertNatural(str) {
  if (pause.stale) return
  replaceRange(pause.pos, pause.pos, str)
  pause.open = false
}
function confirmPause() {
  if (pause.stale || pauseError.value) return
  const marker = pauseMarker(Math.round(Number(pause.seconds) * 10) / 10)
  if (pause.editing) replaceRange(pause.editing.start, pause.editing.end, marker)
  else replaceRange(pause.pos, pause.pos, marker)
  pause.open = false
}

// ---------- 多音字检查：列出正文（未注音部分）里所有多音字 ----------
const check = reactive({ open: false, loading: false, items: [] })
// deeplink（#86）：四个浮层都要能直达。check 是纯本地计算，可以直接恢复；
// 注音/语气/停顿依附正文位置，链接里带上宿主分镜 + 区间 +（注音还带）源文字，
// 恢复时先用当前已保存正文校验：对得上才按原样打开，对不上只读打开并明示，绝不插到错位置。
const link = useDeeplink('narration', DEEPLINK_KEYS.narration.filter(key => key === 'nedlg'))
const urlDialog = querySingle(link.initial('nedlg'))

/** 当前浮层的链接身份：<种类>:<分镜 id>[:<区间>[:<源文字>]] */
function markerLinkKey() {
  const id = props.deeplinkId
  if (!(id > 0)) return ''
  if (check.open) return `check:${id}`
  if (pron.open) return `pron:${id}:${pron.start}-${pron.end}:${encodeURIComponent(pron.base || '')}`
  if (tone.open) return `tone:${id}:${tone.editing ? `${tone.editing.start}-${tone.editing.end}` : tone.pos}`
  if (pause.open) return `pause:${id}:${pause.editing ? `${pause.editing.start}-${pause.editing.end}` : pause.pos}`
  return ''
}
watch(
  () => [check.open, pron.open, tone.open, pause.open, pron.start, pron.end, tone.pos, pause.pos].join('|'),
  () => link.set({ nedlg: markerLinkKey() }),
  { immediate: true },
)

/** 已保存正文里 [start,end) 上的同类标记（恢复「编辑已有标记」用） */
function markerSegmentAt(start, end, types) {
  return parsed.value.segments.find(seg => seg.start === start && seg.end === end && types.includes(seg.type)) || null
}

/** 位置对不上时的只读外壳：保留宿主、区间与链接记录的内容，但不允许提交 */
function openStale(kind, start, end, base) {
  if (kind === 'pron') {
    Object.assign(pron, { rows: [], start, end, base, editing: null, mode: 'pinyin', homophone: '', stale: true, open: true })
  } else if (kind === 'tone') {
    Object.assign(tone, { value: '', pos: start, editing: null, stale: true, open: true })
  } else {
    Object.assign(pause, { seconds: 1, pos: start, editing: null, stale: true, open: true })
  }
  toast.warning(t('deeplink.staleRange'))
}

async function restoreMarkerDeeplink() {
  const matched = /^(check|pron|tone|pause):(\d+)(?::(\d+)(?:-(\d+))?(?::(.*))?)?$/.exec(urlDialog || '')
  if (!matched) return
  const [, kind, idText, startText, endText, baseText] = matched
  if (!(props.deeplinkId > 0) || Number(idText) !== props.deeplinkId) return
  if (kind === 'check') { void openCheck(); return }
  const start = Number(startText || 0)
  const end = endText === undefined ? start : Number(endText)
  if (!Number.isInteger(start) || start < 0 || start > text.value.length) { openStale(kind, 0, 0, ''); return }
  if (kind === 'pron') {
    const base = decodeURIComponent(baseText || '')
    const seg = markerSegmentAt(start, end, ['ruby', 'invalid'])
    if (seg && (!base || seg.base === base)) { await openPron({ start, end }, seg); return }
    if (base && text.value.slice(start, end) === base && !markerAt(text.value, start)) { await openPron({ start, end }); return }
    openStale('pron', start, end, base)
    return
  }
  const types = kind === 'tone' ? ['tone'] : ['pause']
  const seg = end > start ? markerSegmentAt(start, end, types) : null
  if (seg) { await (kind === 'tone' ? openTone(seg) : openPause(seg)); return }
  // 插入位（没有区间）：位置必须仍是合法插入点，否则只读
  if (end === start && safeInsertPos(start) === start && !markerAt(text.value, start)) {
    await (kind === 'tone' ? openTone() : openPause())
    if (kind === 'tone') tone.pos = start
    else pause.pos = start
    return
  }
  openStale(kind, start, end, '')
}
void restoreMarkerDeeplink()
async function openCheck() {
  check.open = true
  check.loading = true
  const [{ pinyin, polyphonic }] = await Promise.all([loadPinyin(), loadCatalog()])
  const items = []
  for (const seg of parsed.value.segments) {
    if (seg.type !== 'text') continue
    const contextual = pinyin(seg.text, { type: 'array', toneType: 'num' })
    ;[...seg.text].forEach((char, i) => {
      if (!CJK_CHAR.test(char)) return
      const readings = [...new Set((polyphonic(char, { type: 'array', toneType: 'num' })[0] || []).filter(py => /[1-4]$/.test(py)))]
      if (readings.length < 2) return
      const index = seg.start + i
      items.push({
        index,
        char,
        before: text.value.slice(Math.max(0, index - 4), index),
        after: text.value.slice(index + 1, index + 5),
        defaultMark: toneMark(contextual[i] || ''),
        readings: readings.map(toneMark).join(' / '),
      })
    })
  }
  check.items = items
  check.loading = false
}
</script>

<style scoped>
.nedit { display: flex; flex-direction: column; gap: 6px; }
.nedit-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.nedit-tip { font-size: 11px; color: var(--text-3); }
.nedit-area { position: relative; display: flex; flex-direction: column; }
.nedit-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  overflow: hidden;
  scrollbar-gutter: stable;
  pointer-events: none;
}
.nedit-backdrop-content { white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }
.nedit-input {
  position: relative;
  z-index: 1;
  width: 100%;
  resize: none;
  overflow-y: hidden;
  scrollbar-gutter: stable;
  background: transparent;
  color: transparent;
  caret-color: var(--text-0);
}
.nedit-input::placeholder { color: var(--text-3); }
/* 标记着色：不改字距/字重/内边距，保证与透明文本逐字对齐 */
.nedit-backdrop :deep(.nedit-token) { border-radius: 3px; }
.nedit-backdrop :deep(.nedit-token.is-ruby) { color: var(--accent-text); background: var(--accent-bg); }
.nedit-backdrop :deep(.nedit-token.is-pause) { color: var(--tag-success-text); background: var(--success-bg); }
.nedit-backdrop :deep(.nedit-token.is-tone) { color: var(--tag-info-text); background: var(--info-bg); }
.nedit-backdrop :deep(.nedit-token.is-invalid) { color: var(--action-danger); background: var(--action-danger-bg); text-decoration: underline wavy; }
.nedit-markerbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.nedit-chip { padding: 2px 8px; border-radius: 10px; font-size: 12px; background: var(--bg-2); color: var(--text-1); }
.nedit-chip.is-ruby { background: var(--accent-bg); color: var(--accent-text); }
.nedit-chip.is-tone { background: var(--info-bg); color: var(--tag-info-text); }
.nedit-chip.is-pause { background: var(--success-bg); color: var(--tag-success-text); }
.nedit-chip.is-invalid { background: var(--action-danger-bg); color: var(--action-danger); }
.nedit-preview { display: flex; gap: 6px; font-size: 12px; color: var(--text-1); padding: 6px 8px; border-radius: 6px; background: var(--bg-2); }
.nedit-preview-label { color: var(--text-3); white-space: nowrap; }
.nedit-errors { margin: 0; padding-left: 18px; font-size: 11px; color: var(--action-danger); }
.nedit-error { margin: 0; font-size: 11px; color: var(--action-danger); }
.nedit-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.nedit-overlay { z-index: 119; }
.nedit-dialog { width: 520px; max-width: 94vw; }
.nedit-body { display: flex; flex-direction: column; gap: 10px; max-height: 70vh; overflow-y: auto; }
.nedit-modes { display: flex; gap: 6px; }
.nedit-modes .is-on { border-color: var(--action-primary); color: var(--action-primary); }
.nedit-pron-row { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--border); }
.nedit-pron-char { font-size: 26px; line-height: 1.2; min-width: 40px; text-align: center; color: var(--text-0); }
.nedit-pron-opts { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.nedit-cands { display: flex; gap: 6px; flex-wrap: wrap; }
.nedit-cand {
  display: inline-flex;
  gap: 4px;
  align-items: baseline;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-soft);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}
.nedit-cand.is-on { border-color: var(--action-primary); color: var(--action-primary); box-shadow: 0 0 0 1px var(--action-primary) inset; }
.nedit-cand .dim { color: var(--text-3); font-size: 11px; }
.nedit-py-input { width: 180px; }
.nedit-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-1); }
.nedit-seconds { width: 120px; }
.nedit-group-label { font-size: 11px; font-weight: 600; color: var(--text-2); }
.nedit-tone-group { display: flex; flex-direction: column; gap: 4px; }
.nedit-check-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--text-1);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.nedit-check-ctx mark { background: var(--accent-bg); color: var(--accent-text); padding: 0 2px; border-radius: 3px; }
.nedit-check-row .dim { color: var(--text-3); font-size: 11px; }
</style>
