<template>
  <div class="studio-fullscreen">
    <slot />
  </div>
</template>

<style scoped>
/* 工作台最小可用宽度 1280px（见 AGENTS.md 页面尺寸规格）：更窄的视口横向滚动，不继续压缩内容 */
.studio-fullscreen { height: 100vh; display: flex; flex-direction: column; overflow-x: auto; overflow-y: hidden; background: var(--bg-base); }
</style>
