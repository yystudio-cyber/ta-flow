<template>
  <div class="page-wrap">
    <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:6px">
      <h1 class="page-h1">{{ t('dashboard.title') }}</h1>
      <span style="font-size:13px;opacity:0.55">{{ dateText }}</span>
      <span style="flex:1"></span>
      <span class="risk-pill" :style="{ background: R.bg, color: R.col }">
        <span style="width:8px;height:8px;border-radius:999px;background:currentColor"></span>{{ t('dashboard.riskLevel') }} · {{ R.name }}
      </span>
    </div>
    <p style="margin:0 0 24px;font-size:13.5px;color:var(--color-neutral-700)">{{ greeting }}</p>

    <!-- 猎聘分面：与 BOSS 并排展示，数据完全独立（一个平台的动作绝不触发另一个） -->
    <div class="card" style="margin-bottom:18px;border-left:3px solid var(--color-accent)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span class="card-kicker" style="flex:1">{{ t('dashboard.liepinToday') }}</span>
        <span class="tag" :class="lp.rpa?.isRunning ? 'tag-accent-2' : ''">
          {{ lp.rpa?.isRunning ? t('common.running') : t('common.notRunning') }}
        </span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px">
        <div>
          <div style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ lp.talents?.today ?? 0 }}</div>
          <div style="font-size:12px;opacity:.65;margin-top:4px">{{ t('dashboard.todayNetNewPre') }}<b>{{ t('dashboard.todayNetNewBold') }}</b>{{ t('dashboard.todayNetNewPost') }}</div>
        </div>
        <div>
          <div style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ lp.today?.viewed ?? 0 }}</div>
          <div style="font-size:12px;opacity:.65;margin-top:4px">{{ t('dashboard.cardsViewed') }}</div>
        </div>
        <div>
          <div style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ lp.today?.pages ?? 0 }}</div>
          <div style="font-size:12px;opacity:.65;margin-top:4px">{{ t('dashboard.paged') }}</div>
        </div>
        <div>
          <div style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ lp.today?.details ?? 0 }}</div>
          <div style="font-size:12px;opacity:.65;margin-top:4px">{{ t('dashboard.resumeViewedPre') }}<b>{{ t('dashboard.resumeViewedBold') }}</b>{{ t('dashboard.resumeViewedPost') }}</div>
        </div>
        <div>
          <div style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ lp.talents?.total ?? 0 }}</div>
          <div style="font-size:12px;opacity:.65;margin-top:4px">{{ t('dashboard.talentPool') }}</div>
        </div>
      </div>
      <p style="margin:12px 0 0;font-size:12px;color:var(--color-neutral-600)">
        {{ t('dashboard.netNewExplain') }}
        <span v-if="lp.talents?.expiring">{{ t('dashboard.expiringNotice', { n: lp.talents.expiring }) }}</span>
      </p>
      <!-- 猎聘 7 日翻页趋势：与 BOSS 趋势图物理分离，避免视觉串台（阶段2：按平台各自取数） -->
      <div v-if="lpWeek.length" style="display:flex;align-items:flex-end;gap:6px;margin-top:14px;height:46px">
        <div v-for="(d, i) in lpWeek" :key="i" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px" :title="t('dashboard.weekPageTooltip', { date: d.date, pages: d.pages })">
          <div :style="{
            width: '100%', borderRadius: '3px 3px 0 0',
            height: lpBarH(d.pages) + 'px',
            background: d.pages > 0 ? 'var(--color-accent)' : 'var(--color-neutral-200)',
            minHeight: d.pages > 0 ? '4px' : '2px',
          }"></div>
          <span style="font-size:9.5px;opacity:0.5">{{ d.date.slice(-2) }}</span>
        </div>
      </div>
      <div v-if="lpWeek.length" style="font-size:11px;opacity:0.55;margin-top:6px">{{ t('dashboard.weekPagesTrend', { n: lpWeekSum }) }}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:18px">
      <div class="card">
        <div class="card-kicker">{{ t('dashboard.bossTodaySourcing') }}</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin:10px 0 2px">
          <span style="font-family:var(--font-heading);font-size:38px;line-height:1">{{ today.viewed }}</span>
          <span style="font-size:12.5px;opacity:0.6">{{ t('dashboard.peopleBrowsed') }}</span>
        </div>
        <div style="display:flex;gap:14px;margin-top:12px;font-size:12.5px">
          <span>{{ t('dashboard.greet') }} <strong>{{ today.greeted }}</strong><span style="opacity:0.5">/{{ greetLimit }}</span></span>
          <span>{{ t('dashboard.favorite') }} <strong>{{ today.favorited }}</strong></span>
        </div>
      </div>
      <div class="card">
        <div class="card-kicker">{{ t('dashboard.todayMatchDist') }}</div>
        <div style="display:grid;gap:9px;margin-top:14px;font-size:12.5px">
          <div style="display:flex;align-items:center;gap:9px"><span class="dotc" style="background:var(--color-accent-2)"></span><span style="flex:1">{{ t('dashboard.highMatch', { n: hiT }) }}</span><strong>{{ t('dashboard.matchPeople', { n: today.highMatch }) }}</strong></div>
          <div style="display:flex;align-items:center;gap:9px"><span class="dotc" style="background:var(--color-accent)"></span><span style="flex:1">{{ t('dashboard.midMatch', { lo: loT, hi: hiT - 1 }) }}</span><strong>{{ t('dashboard.matchPeople', { n: today.midMatch }) }}</strong></div>
          <div style="display:flex;align-items:center;gap:9px"><span class="dotc" style="background:var(--color-neutral-400)"></span><span style="flex:1">{{ t('dashboard.lowMatch', { n: loT }) }}</span><strong>{{ t('dashboard.matchPeople', { n: today.lowMatch }) }}</strong></div>
        </div>
        <div style="display:flex;height:8px;border-radius:999px;overflow:hidden;margin-top:14px">
          <span :style="{ width: pctHigh + '%', background: 'var(--color-accent-2)' }"></span>
          <span :style="{ width: pctMid + '%', background: 'var(--color-accent-300)' }"></span>
          <span :style="{ width: pctLow + '%', background: 'var(--color-neutral-300)' }"></span>
        </div>
      </div>
      <div class="card" :style="{ background: R.bg }">
        <div class="card-kicker">{{ t('dashboard.currentRiskLevel') }}</div>
        <div style="display:flex;align-items:center;gap:12px;margin:12px 0 8px">
          <span style="width:14px;height:14px;border-radius:999px" :style="{ background: R.col }"></span>
          <span style="font-family:var(--font-heading);font-size:30px;line-height:1">{{ R.name }}</span>
        </div>
        <div style="font-size:12.5px;color:var(--color-neutral-700)">{{ riskShort }}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:16px">
        <div class="card-kicker" style="flex:1">{{ t('dashboard.weekTrend') }}</div>
        <span class="legend"><span style="width:14px;height:3px;border-radius:99px;background:var(--color-accent)"></span>{{ t('dashboard.legendViewed') }}</span>
        <span class="legend"><span style="width:14px;height:3px;border-radius:99px;background:var(--color-accent-2)"></span>{{ t('dashboard.legendGreeted') }}</span>
      </div>
      <svg viewBox="0 0 700 190" style="width:100%;height:auto;display:block;margin-top:8px">
        <line x1="30" y1="160" x2="670" y2="160" stroke="var(--color-neutral-300)" stroke-width="1"></line>
        <line x1="30" y1="92" x2="670" y2="92" stroke="var(--color-neutral-200)" stroke-width="1" stroke-dasharray="3 5"></line>
        <line x1="30" y1="24" x2="670" y2="24" stroke="var(--color-neutral-200)" stroke-width="1" stroke-dasharray="3 5"></line>
        <polyline :points="linePts('viewed', maxV)" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <polyline :points="linePts('greeted', maxG)" fill="none" stroke="var(--color-accent-2)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 7"></polyline>
        <template v-for="(d, i) in trend" :key="i">
          <text :x="ptX(i)" y="180" font-size="11" fill="var(--color-neutral-500)" text-anchor="middle">{{ d.date.slice(-2) }}</text>
        </template>
      </svg>
    </div>

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:18px">
      <div class="card">
        <div class="card-kicker">{{ t('dashboard.activeJd') }}</div>
        <div v-if="activeJd" style="display:flex;align-items:center;gap:12px;margin-top:12px">
          <div style="font-family:var(--font-heading);font-size:19px">{{ activeJd.name }}</div>
          <span class="tag tag-accent-2">{{ t('dashboard.scoreActive') }}</span>
        </div>
        <div v-if="activeJd" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
          <span class="tag tag-neutral">{{ activeJd.basic.city }}</span>
          <span class="tag tag-neutral">{{ activeJd.basic.experienceMin }}-{{ activeJd.basic.experienceMax }}{{ t('dashboard.years') }}</span>
          <span class="tag tag-neutral">{{ activeJd.basic.degree }}</span>
          <span class="tag tag-neutral" v-for="k in activeJd.keywords.required.slice(0,3)" :key="k">{{ k }}</span>
        </div>
        <div v-else style="margin-top:12px;font-size:13px;color:var(--color-neutral-600)">{{ t('dashboard.noJd') }}</div>
      </div>
      <div class="card">
        <div class="card-kicker">{{ t('dashboard.quickActions', { name: platLabel }) }}</div>
        <div style="display:flex;align-items:center;gap:9px;margin:12px 0 4px;font-size:12.5px">
          <span style="width:8px;height:8px;border-radius:999px" :style="{ background: (store.cdpConnected || store.browserOpen) ? 'var(--color-accent-2)' : 'var(--color-neutral-400)' }"></span>
          <span style="flex:1">{{ browserStateLabel }}</span>
          <button v-if="!store.cdpConnected && !store.browserOpen" type="button" class="btn btn-secondary" style="padding:5px 14px" @click="connectBrowser">{{ t('dashboard.openLogin', { name: platLabel }) }}</button>
        </div>
        <div style="display:grid;gap:10px;margin-top:8px">
          <button type="button" class="btn btn-primary btn-block" :disabled="hunting" @click="huntNow">{{ hunting ? t('dashboard.hunting') : (activeJd ? t('dashboard.startHuntWithJd', { name: activeJd.name }) : t('dashboard.startHunt')) }}</button>
          <div style="display:flex;gap:10px">
            <button type="button" class="btn btn-secondary" style="flex:1" @click="$router.push('/match')">{{ t('dashboard.goMatch') }}</button>
            <button type="button" class="btn btn-ghost" style="flex:1" @click="exportCsv">{{ t('dashboard.exportTodayCsv') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../../stores/app';
import type { DashboardStats } from '../../../../shared/types';
import { makeDefaultTask, getDefaultLimits } from '../../../../shared/utils';

const { t } = useI18n();
const router = useRouter();
const store = useAppStore();
const stats = ref<DashboardStats>({
  today: { viewed: 0, greeted: 0, favorited: 0, highMatch: 0, midMatch: 0, lowMatch: 0 },
  weekTrend: [], risk: store.riskState, rpa: { isRunning: false },
});
const today = computed(() => stats.value.today);
// 猎聘分面。后端没返回时给全空对象兜底，避免旧数据形态下整页白屏。
const lp = computed<any>(() => (stats.value as any).liepin || {});
// 匹配分布标签跟随设置里的高/低阈值（与实际评分口径一致）
const hiT = computed(() => store.settings?.matchScore?.highThreshold ?? 75);
const loT = computed(() => store.settings?.matchScore?.lowThreshold ?? 60);
// 打招呼上限跟随默认速度档（与实际每日上限一致，不再硬编码 /100）
const greetLimit = computed(() => getDefaultLimits((store.settings?.rpa?.defaultSpeed as any) || 'human').greet);
const trend = computed(() => stats.value.weekTrend);
const activeJd = computed(() => stats.value.activeJD);

const dateText = computed(() => {
  const d = new Date();
  const wd = t('dashboard.weekdays').split(',')[d.getDay()];
  return t('dashboard.dateWeek', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), w: wd });
});
const greeting = computed(() => {
  const r = store.riskState;
  if (r.level === 'danger') return r.suggestions?.[0] || t('dashboard.greetingDanger');
  if (r.level === 'notice') return r.suggestions?.[0] || t('dashboard.greetingNotice');
  return t('dashboard.greetingSafe');
});

const RISK: Record<string, { name: string; col: string; bg: string }> = {
  safe: { name: t('dashboard.riskSafe'), col: 'var(--color-accent-2)', bg: 'var(--color-accent-2-100)' },
  notice: { name: t('dashboard.riskNotice'), col: 'var(--color-accent)', bg: 'var(--color-accent-100)' },
  danger: { name: t('dashboard.riskDanger'), col: 'var(--color-accent-800)', bg: 'var(--color-accent-200)' },
};
const R = computed(() => RISK[store.riskState.level] || RISK.safe);
const riskShort = computed(() => store.riskState.reasons?.[0] || (store.riskState.level === 'safe' ? t('dashboard.riskSafeShort') : store.riskState.suggestions?.[0] || ''));

const totalMatch = computed(() => Math.max(1, today.value.highMatch + today.value.midMatch + today.value.lowMatch));
const pctHigh = computed(() => Math.round((today.value.highMatch / totalMatch.value) * 100));
const pctMid = computed(() => Math.round((today.value.midMatch / totalMatch.value) * 100));
const pctLow = computed(() => Math.max(0, 100 - pctHigh.value - pctMid.value));

const maxV = computed(() => Math.max(1, ...trend.value.map((d) => d.viewed)));
const maxG = computed(() => Math.max(1, ...trend.value.map((d) => d.greeted)));
// 猎聘 7 日翻页趋势（阶段2）：取后端 liepin.weekTrend，与 BOSS 趋势图独立，绝不串台
const lpWeek = computed(() => (lp.value?.weekTrend || []) as Array<{ date: string; viewed: number; pages: number }>);
const lpWeekSum = computed(() => lpWeek.value.reduce((s, d) => s + (d.pages || 0), 0));
function lpBarH(pages: number): number {
  const max = Math.max(1, ...lpWeek.value.map((d) => d.pages || 0));
  return Math.round(((pages || 0) / max) * 36); // 最高 36px
}
function ptX(i: number) { const n = trend.value.length; return n <= 1 ? 350 : 30 + (i / (n - 1)) * 640; }
function ptY(v: number, max: number) { return 160 - (v / max) * 136; }
function linePts(key: 'viewed' | 'greeted', max: number) {
  return trend.value.map((d, i) => `${ptX(i)},${ptY(d[key], max)}`).join(' ');
}

async function refresh() {
  try { stats.value = await window.api.getDashboard(); } catch { /* keep defaults */ }
}
// 如实汇报「打开浏览器」的结果：区分"新启动 / 本来就开着并已切前台 / 切前台失败"，
// 不再一律报"已打开"（那会在浏览器藏在 app 后面时表现为"点了没反应却显示成功"）。
// 阶段2：按当前活动平台打开（BOSS/猎聘各有专属浏览器与端口，互不串台）。
function reportOpenResult(r: { launched: boolean; alreadyOpen: boolean; focused: boolean }) {
  const label = platLabel;
  if (r.launched) {
    ElMessage.success(t('dashboard.openLaunched', { name: label }));
  } else if (r.focused) {
    ElMessage.success(t('dashboard.openFocused', { name: label }));
  } else {
    ElMessage.warning(t('dashboard.openNotFocused', { name: label }));
  }
}

// 平台显示名（BOSS 恒为拉丁名；猎聘按语言译）。与 Sidebar 一致。
const platLabel = computed(() => (store.activePlatform === 'liepin' ? t('common.liepin') : 'BOSS'));
// 当前平台浏览器状态文案
const browserStateLabel = computed(() => {
  const name = platLabel.value;
  if (store.cdpConnected) return t('dashboard.browserFindingState', { name });
  if (store.browserOpen) return t('dashboard.browserOpenedState', { name });
  return t('dashboard.browserClosedState', { name });
});

async function connectBrowser() {
  try {
    const r = await window.api.openBrowserForLogin(store.activePlatform);
    reportOpenResult(r);
  } catch (e: any) { ElMessage.error(e.message || t('dashboard.openFailed')); }
}

// 一键「开始找人」：连浏览器 → 用激活岗位 → 自动建/复用任务 → 启动。用户无需理解"任务"概念。
// 阶段2：连浏览器/建任务/启动都按当前活动平台，一个平台的动作绝不触发另一个平台。
const hunting = ref(false);
async function huntNow() {
  hunting.value = true;
  try {
    const plat = store.activePlatform;
    if (!store.cdpConnected) {
      try {
        await window.api.smartConnect(plat);
      } catch {
        ElMessage.warning(t('dashboard.connectFirst', { name: (plat === 'liepin' ? t('common.liepin') : 'BOSS') }));
        return;
      }
    }
    if (!activeJd.value) {
      ElMessage.warning(t('dashboard.activateJdFirst'));
      router.push('/match');
      return;
    }
    const tasks = await window.api.listTasks(plat);
    let taskId = tasks[0]?.id;
    if (!taskId) {
      const speed = (store.settings?.rpa?.defaultSpeed as any) || 'human';
      const t2 = await window.api.saveTask(makeDefaultTask(activeJd.value.name, speed, plat));
      taskId = t2.id;
    }
    await window.api.startRpa(taskId, plat);
    ElMessage.success(t('dashboard.startHuntingMsg'));
    router.push('/rpa');
  } catch (e: any) {
    ElMessage.error(e.message || t('dashboard.startFailed'));
  } finally {
    hunting.value = false;
  }
}
async function exportCsv() { await window.api.exportCsv({ platform: store.activePlatform }); ElMessage.success(t('dashboard.exportCsvDone')); }

onMounted(refresh);
</script>

<style scoped>
.risk-pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 16px; border-radius: 999px; font-size: 13px; font-weight: 700; }
.dotc { width: 9px; height: 9px; border-radius: 999px; flex: none; }
.legend { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: 0.7; }
</style>
