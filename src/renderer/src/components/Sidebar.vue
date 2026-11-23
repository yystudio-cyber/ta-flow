<template>
  <aside class="ta-side">
    <div class="ta-brand">
      <div class="ta-logo">TA</div>
      <div>
        <div class="ta-brand-name">{{ t('nav.brandName') }}</div>
        <div class="ta-brand-sub">{{ t('nav.brandSub') }}</div>
      </div>
    </div>

    <router-link
      v-for="item in nav"
      :key="item.to"
      :to="item.to"
      class="ta-nav-item"
      :class="{ active: isActive(item.to) }"
    >
      <span class="ta-nav-ico" v-html="item.icon"></span>
      <span>{{ t(item.labelKey) }}</span>
    </router-link>

    <div style="flex: 1"></div>

    <!-- D6(2026-08-05)：平台切换提至全局侧边栏，持久化；原 RpaPage 内部 tabs-bar 保留但复用这里的状态 -->
    <div class="ta-platform">
      <div class="ta-platform-label">{{ t('nav.platformLabel') }}</div>
      <div class="ta-platform-seg">
        <button type="button" class="ta-plat-btn" :class="{ active: store.activePlatform === 'boss' }"
          @click="switchPlat('boss')">BOSS</button>
        <button type="button" class="ta-plat-btn" :class="{ active: store.activePlatform === 'liepin' }"
          @click="switchPlat('liepin')">{{ t('common.liepin') }}</button>
      </div>
    </div>

    <div class="ta-cdp">
      <span class="ta-cdp-dot" :style="{ background: (store.cdpConnected || store.browserOpen) ? 'var(--color-accent-2)' : 'var(--color-neutral-400)' }"></span>
      <span style="opacity: 0.75">{{ cdpLabel }}</span>
    </div>
    <div class="ta-ver">{{ t('nav.version') }}</div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const { t } = useI18n();
const store = useAppStore();
const route = useRoute();
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));

// D6(2026-08-05)：平台切换走 store.setActivePlatform（持久化），而不是直接改 ref
function switchPlat(p: 'boss' | 'liepin') { void store.setActivePlatform(p); }
// 平台显示名（BOSS 恒为拉丁名；猎聘按语言译）
const platformName = (p: string) => (p === 'liepin' ? t('common.liepin') : 'BOSS');
// CDP 状态文案跟随所选平台
const cdpLabel = computed(() => {
  const name = platformName(store.activePlatform);
  if (store.cdpConnected) return t('nav.browserFinding', { name });
  if (store.browserOpen) return t('nav.browserOpened', { name });
  return t('nav.browserClosed', { name });
});

const I = (p: string) =>
  `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

const nav = [
  { to: '/', labelKey: 'nav.dashboard', icon: I('<path d="M3 10.5 12 3l9 7.5V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z"></path><path d="M9 21.5v-7h6v7"></path>') },
  { to: '/rpa', labelKey: 'nav.rpa', icon: I('<rect x="3" y="10" width="18" height="10" rx="3"></rect><path d="M12 10V6"></path><circle cx="12" cy="4.5" r="1.5"></circle><path d="M8.5 15h.01"></path><path d="M15.5 15h.01"></path>') },
  { to: '/match', labelKey: 'nav.match', icon: I('<rect x="3" y="7" width="18" height="13" rx="3"></rect><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"></path><path d="M3 12.5h18"></path>') },
  { to: '/talent', labelKey: 'nav.talent', icon: I('<circle cx="9" cy="8.5" r="3.5"></circle><path d="M2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5"></path><circle cx="17.5" cy="9.5" r="2.5"></circle><path d="M15.5 14.8c2.7.2 5 2 5.9 4.7"></path>') },
  { to: '/tools', labelKey: 'nav.tools', icon: I('<rect x="3" y="3" width="7.5" height="7.5" rx="2.5"></rect><rect x="13.5" y="3" width="7.5" height="7.5" rx="2.5"></rect><rect x="3" y="13.5" width="7.5" height="7.5" rx="2.5"></rect><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.5"></rect>') },
  { to: '/risk', labelKey: 'nav.risk', icon: I('<path d="M10.3 3.9 2.4 17.5A1.9 1.9 0 0 0 4 20.5h16a1.9 1.9 0 0 0 1.6-3L13.7 3.9a1.9 1.9 0 0 0-3.4 0z"></path><path d="M12 9v4.5"></path><path d="M12 17h.01"></path>') },
  { to: '/oplog', labelKey: 'nav.oplog', icon: I('<path d="M4 5h16"></path><path d="M4 10h16"></path><path d="M4 15h10"></path><path d="M4 20h7"></path>') },
  { to: '/settings', labelKey: 'nav.settings', icon: I('<path d="M4 8h10"></path><circle cx="17.5" cy="8" r="2.5"></circle><path d="M20 16H10"></path><circle cx="6.5" cy="16" r="2.5"></circle>') },
];
</script>

<style scoped>
.ta-side {
  width: 230px; flex: none; display: flex; flex-direction: column; gap: 6px;
  padding: 22px 14px 16px; background: var(--color-neutral-100);
  border-right: 1px solid rgba(0, 0, 0, 0.06);
}
.ta-brand { display: flex; align-items: center; gap: 12px; padding: 0 8px 18px; }
.ta-logo {
  width: 42px; height: 42px; flex: none; border-radius: 999px;
  background: var(--color-accent); color: var(--color-bg);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-heading); font-size: 17px;
}
.ta-brand-name { font-family: var(--font-heading); font-size: 16px; line-height: 1.1; }
.ta-brand-sub { font-size: 10.5px; opacity: 0.55; letter-spacing: 0.06em; }
.ta-nav-item {
  display: flex; align-items: center; gap: 11px; padding: 10px 14px;
  border-radius: 999px; cursor: pointer; font-size: 13.5px; font-weight: 600;
  text-decoration: none; color: var(--color-text); transition: background .15s, color .15s;
}
.ta-nav-item:hover { background: rgba(0, 0, 0, 0.05); }
.ta-nav-item.active { color: var(--color-bg); background: var(--color-accent); }
.ta-nav-ico { display: inline-flex; }
/* D6(2026-08-05)：全局平台切换器 */
.ta-platform { padding: 4px 14px 0; }
.ta-platform-label { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.5; margin-bottom: 6px; }
.ta-platform-seg { display: flex; background: rgba(0,0,0,.06); border-radius: 999px; padding: 3px; }
.ta-plat-btn { flex: 1; border: none; background: transparent; padding: 6px 0; border-radius: 999px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--color-neutral-600); transition: background .15s, color .15s; }
.ta-plat-btn.active { background: var(--color-accent); color: var(--color-bg); }
.ta-cdp {
  display: flex; align-items: center; gap: 9px; padding: 12px 14px;
  border-radius: var(--radius-lg); background: rgba(0, 0, 0, 0.04); font-size: 11.5px;
}
.ta-cdp-dot { width: 8px; height: 8px; flex: none; border-radius: 999px; }
.ta-ver { padding: 10px 14px 0; font-size: 10.5px; opacity: 0.4; }
</style>
