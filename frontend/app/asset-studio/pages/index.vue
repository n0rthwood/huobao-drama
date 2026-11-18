<template>
  <main class="as-page">
    <header><div><h1>{{ t('assetStudio.title') }}</h1><p class="dim">{{ t('assetStudio.description') }}</p></div><button class="btn btn-sm" :disabled="loading" @click="load">{{ t('assetStudio.refresh') }}</button></header>
    <input v-model="search" class="input" :placeholder="t('assetStudio.search')" :aria-label="t('assetStudio.search')" />
    <StudioError :error="error" />
    <p v-if="loading">{{ t('common.loading') }}</p>
    <p v-else-if="!filtered.length" class="dim">{{ t('assetStudio.empty') }}</p>
    <ul class="as-tasks"><li v-for="task in filtered" :key="task.id"><NuxtLink :to="`/asset-studio/${task.id}`"><strong>{{ task.title }}</strong><span class="dim">{{ task.host_ref }} · {{ new Date(task.updated_at).toLocaleString() }}</span></NuxtLink></li></ul>
    <button class="btn btn-sm" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">{{ t('assetStudio.settings') }}</button>
    <ModuleSettings v-if="settingsOpen" />
  </main>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { assetStudioAPI, type AssetStudioTask } from '../api'
import StudioError from '../components/StudioError.vue'
import ModuleSettings from '../components/ModuleSettings.vue'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'
const { t } = useI18n()
const link = useDeeplink('assetStudioList', DEEPLINK_KEYS.assetStudioList)
const search = ref(String(link.initial('asq') || ''))
const settingsOpen = ref(link.initial('assetsettings') === '1')
const tasks = ref<AssetStudioTask[]>([])
const loading = ref(false)
const error = ref('')
const filtered = computed(() => tasks.value.filter(task => `${task.title} ${task.host_ref}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
watch([search, settingsOpen], () => link.set({asq: search.value, assetsettings: settingsOpen.value ? '1' : ''}))
async function load() {
  loading.value = true; error.value = ''
  try { tasks.value = (await assetStudioAPI.listTasks()).tasks }
  catch (err) { error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }
  finally { loading.value = false }
}
onMounted(async () => { await load(); deeplinkHydrate() })
</script>
<style scoped>
.as-page { max-width: 1280px; margin: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1 { font-size: 22px; margin: 0; } p { margin: 6px 0; }
.as-tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.as-tasks a { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-1); background: var(--surface); }
</style>
