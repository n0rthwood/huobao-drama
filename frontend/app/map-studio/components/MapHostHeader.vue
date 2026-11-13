<template>
  <header class="mh">
    <div class="mh-title">
      <strong>{{ target?.title || title }}</strong>
      <span v-if="target?.subtitle" class="dim">{{ target.subtitle }}</span>
      <span class="mh-chip">{{ host ? t('mapStudio.host.huobao') : t('mapStudio.host.standalone') }}</span>
      <span class="dim">{{ t('mapStudio.host.taskRef', { id: taskId }) }}</span>
    </div>
    <div class="mh-actions">
      <button v-if="target?.return_path" type="button" class="mh-tool" @click="goBack">
        <ArrowLeft :size="12" />
        {{ t('mapStudio.host.returnHuobao') }}
      </button>
      <span v-if="host && !target" class="mh-warn">{{ t('mapStudio.host.targetMissing') }}</span>
    </div>
  </header>
</template>

<script setup lang="ts">
/**
 * 宿主目标抬头（Issue #99）。
 *
 * 宿主任务显示道具名 +《剧名》E02 与「返回火宝」；返回走应用内 router（return_path 是火宝内的 SPA 路径，
 * 不含 baseURL 前缀），不在模块里自己拼部署前缀。
 * target 为 null = 道具已删除或不再是地图：这里只提示只读，运行/交付由服务端 400 host_target_missing 兜底。
 */
import { ArrowLeft } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapStudioHostRef } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  taskId: number
  title: string
  host: MapStudioHostRef | null
}>()

const router = useRouter()

const target = computed(() => props.host?.target ?? null)

function goBack() {
  const path = target.value?.return_path
  if (!path) return
  void router.push(path)
}
</script>

<style scoped>
.mh { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.mh-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.mh-title strong { font: 600 14px var(--font-body); color: var(--text-0); }
.mh-chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10.5px var(--font-body);
  color: var(--text-2);
}
.mh-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.mh-tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.mh-tool:hover { color: var(--accent-text); border-color: var(--accent-text); }
.mh-warn {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
</style>
