<template>
  <div class="app-shell">
    <Sidebar />
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <!-- 页面级错误边界：一个页面渲染崩溃只坏它自己，换路由即复位（key 按路径） -->
        <PageBoundary :key="$route.fullPath">
          <component :is="Component" />
        </PageBoundary>
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import Sidebar from './components/Sidebar.vue';
import PageBoundary from './components/PageBoundary.vue';
import { onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { useAppStore } from './stores/app';

const appStore = useAppStore();

// H5-1: 深色主题生效逻辑 —— 根据设置在 <html> 上切换 dark class（同时驱动自有变量与 Element Plus 暗色）
// 设置字段为 settings.general.theme，取值 'light' | 'dark'；'system' 作为兼容分支跟随系统
const themeSetting = computed(() => (appStore.settings?.general?.theme as string) ?? 'light');

const mql = window.matchMedia('(prefers-color-scheme: dark)');

// H5-1: 计算最终应生效的深浅色（system 时读系统偏好）
function resolveDark(theme: string): boolean {
  if (theme === 'dark') return true;
  if (theme === 'system') return mql.matches;
  return false; // 'light' 或未知一律浅色
}

// H5-1: 将结果应用到 <html> 根元素
function applyTheme() {
  const isDark = resolveDark(themeSetting.value);
  document.documentElement.classList.toggle('dark', isDark);
}

// H5-1: 系统偏好变化时，仅在 system 模式下实时跟随
function onSystemChange() {
  if (themeSetting.value === 'system') applyTheme();
}

// H5-1: 设置里的 theme 变化实时切换（immediate 覆盖初次异步加载完成的场景）
watch(themeSetting, applyTheme, { immediate: true });

onMounted(() => {
  // init 内部已逐项隔离；这里再兜一层，保证它万一整体 reject 也不影响主题监听等其余挂载逻辑
  appStore.init().catch((e) => console.warn('[App] store 初始化异常（已隔离）：', e));
  mql.addEventListener('change', onSystemChange);
});

onBeforeUnmount(() => {
  mql.removeEventListener('change', onSystemChange);
});
</script>
