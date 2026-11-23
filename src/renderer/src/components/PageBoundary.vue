<template>
  <div v-if="error" class="pb-wrap">
    <div class="pb-card">
      <div class="pb-ico">⚠️</div>
      <div class="pb-title">当前页面出错了</div>
      <div class="pb-msg">{{ error }}</div>
      <div class="pb-hint">只有这个页面受影响，左侧导航和其它功能照常可用。</div>
      <div class="pb-actions">
        <button type="button" class="btn btn-primary" @click="retry">重试</button>
      </div>
    </div>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
// 页面级错误边界（四线隔离 2026-07-29）：路由出口外面这层把任何页面组件在
// 渲染/生命周期/事件回调里抛出的异常就地截住——只坏当前页，侧边栏与其余页面照常。
// 没有它，异常会冒泡到根组件，Vue 中止根 patch，四条线同屏白。
import { ref, onErrorCaptured } from 'vue';

const error = ref('');

onErrorCaptured((err: any, _inst, info) => {
  console.error(`[page-boundary] 页面异常（${info}，已就地隔离）：`, err);
  error.value = String(err?.message || err);
  return false; // 不再向上冒泡
});

function retry() {
  error.value = '';
}
</script>

<style scoped>
.pb-wrap { display: grid; place-items: center; min-height: 60vh; padding: 24px; }
.pb-card { max-width: 460px; text-align: center; padding: 32px 36px; border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-md); }
.pb-ico { font-size: 34px; }
.pb-title { margin-top: 10px; font-family: var(--font-heading); font-size: 20px; }
.pb-msg { margin-top: 10px; font-size: 13px; color: var(--color-neutral-600); word-break: break-all; white-space: pre-wrap; max-height: 130px; overflow: auto; }
.pb-hint { margin-top: 8px; font-size: 12px; color: var(--color-neutral-500); }
.pb-actions { margin-top: 18px; }
</style>
