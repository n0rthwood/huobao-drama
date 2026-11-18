<template><p v-if="error" class="studio-error" role="alert">{{ error }}</p></template>
<script setup lang="ts">
defineProps<{ error: string }>()
</script>
<style scoped>.studio-error { color: var(--action-danger); white-space: pre-wrap; overflow-wrap: anywhere; }</style>
