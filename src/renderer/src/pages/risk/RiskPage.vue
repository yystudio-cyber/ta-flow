<template>
  <div class="page-wrap">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px">
      <h1 class="page-h1" style="flex:1">{{ t('risk.title') }}</h1>
      <button type="button" class="btn btn-secondary" @click="refresh">{{ t('risk.refresh') }}</button>
    </div>

    <!-- ── 风险指数（复合指数，页面主视觉）──────────────────────────────
         算法：指数 = Σ(维度暴露度 × 权重)，即风险管理里通用的 Composite Risk Index 骨架；
         维度选取与严重度定级全部来自 BOSS-RPA风险调查.md 的一手实测结论。
         指数必须可解释——右侧直接给出主因，不做"只有一个数字"的玩具。 -->
    <div class="card" :style="{ background: idxBand.bg, marginBottom: '18px' }">
      <div style="display:flex;align-items:flex-start;gap:22px;flex-wrap:wrap">
        <!-- 环形指数 -->
        <div style="flex:none;position:relative;width:132px;height:132px">
          <svg width="132" height="132" viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="56" fill="none" stroke="rgba(0,0,0,.08)" stroke-width="12" />
            <circle
              cx="66" cy="66" r="56" fill="none" :stroke="idxBand.col" stroke-width="12" stroke-linecap="round"
              :stroke-dasharray="`${(idx.index / 100) * 351.8} 351.8`" transform="rotate(-90 66 66)"
              style="transition:stroke-dasharray .5s ease" />
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
            <div style="font-family:var(--font-heading);font-size:38px;line-height:1" :style="{ color: idxBand.col }">{{ idx.index }}</div>
            <div style="font-size:12px;color:var(--color-neutral-600);margin-top:2px">{{ t('risk.riskIndex') }}</div>
          </div>
        </div>

        <div style="flex:1;min-width:260px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-family:var(--font-heading);font-size:24px;line-height:1.1" :style="{ color: idxBand.col }">{{ idx.bandLabel }}</span>
            <span class="tag" :class="idx.band === 'steady' ? 'tag-accent-2' : 'tag-accent'">{{ idx.action }}</span>
          </div>
          <div style="font-size:12.5px;color:var(--color-neutral-700);margin-top:8px;line-height:1.9">
            <div v-if="idx.topDrivers.length"><b>{{ t('risk.mainDrivers') }}</b></div>
            <div v-for="(d, i) in idx.topDrivers" :key="i">· {{ d }}</div>
            <div v-if="!idx.topDrivers.length">{{ t('risk.noDrivers') }}</div>
          </div>
          <div style="font-size:11.5px;color:var(--color-neutral-600);margin-top:8px">
            {{ t('risk.indexScale') }}
          </div>
        </div>
      </div>

      <!-- 维度拆分 -->
      <div style="margin-top:16px;border-top:1px solid rgba(0,0,0,.07);padding-top:12px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px 20px">
          <div v-for="d in idx.dimensions" :key="d.key">
            <div style="display:flex;align-items:baseline;gap:6px;font-size:12.5px">
              <span style="flex:1">{{ d.label }} <span style="color:var(--color-neutral-600)">·{{ d.weight }}%</span></span>
              <b :style="{ color: expColor(d.exposure) }">{{ d.exposure }}</b>
            </div>
            <div style="height:5px;border-radius:3px;background:rgba(0,0,0,.08);margin-top:4px;overflow:hidden">
              <div :style="{ width: d.exposure + '%', height: '100%', background: expColor(d.exposure) }"></div>
            </div>
            <div style="font-size:11px;color:var(--color-neutral-600);margin-top:3px;line-height:1.5">{{ d.note }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 风控停机解除：pageAnomaly/accountRestricted 是"需人工确认"的闩，不解除就无法再启动找人 -->
    <div v-if="risk.metrics.pageAnomaly || risk.metrics.accountRestricted" class="card" :style="{ background: 'var(--color-accent-200)', marginBottom: '18px' }">
      <div style="display:flex;align-items:center;gap:14px">
        <span style="font-size:22px;line-height:1">🛑</span>
        <div style="flex:1">
          <div style="font-family:var(--font-heading);font-size:18px;line-height:1.15">{{ t('risk.autoStopped') }}</div>
          <div style="font-size:13px;margin-top:4px;color:var(--color-neutral-700)">{{ risk.reasons[0] || t('risk.stoppedReasonFallback') }}</div>
          <div style="font-size:12px;margin-top:4px;color:var(--color-neutral-600)">{{ t('risk.stoppedHint') }}</div>
        </div>
        <button type="button" class="btn btn-primary" :disabled="clearing" @click="clearRisk">{{ clearing ? t('risk.clearing') : t('risk.clearBtn') }}</button>
      </div>
    </div>

    <!-- 精密防范模型：风控冷却窗口（顺信号退，冷却期内禁止调度/空闲自动重启） -->
    <div v-if="cooldownLeftMin > 0" class="card" :style="{ background: 'var(--color-accent-200)', marginBottom: '18px' }">
      <div style="display:flex;align-items:center;gap:14px">
        <span style="font-size:22px;line-height:1">⏸️</span>
        <div style="flex:1">
          <div style="font-family:var(--font-heading);font-size:18px;line-height:1.15">{{ t('risk.cooldownTitle', { n: cooldownLeftMin }) }}</div>
          <div style="font-size:13px;margin-top:4px;color:var(--color-neutral-700)">{{ risk.cooldown?.reason || t('risk.cooldownReasonFallback') }}</div>
          <div style="font-size:12px;margin-top:4px;color:var(--color-neutral-600)">{{ t('risk.cooldownHint') }}</div>
        </div>
      </div>
    </div>

    <!-- 指标卡 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:18px">
      <!-- 2026-08-07 P1-3: greetRed=0 表示本平台不做打招呼（猎聘）。
           0>=0 恒真 → 卡片恒红，零信息量还淹没真实告警。greetRed<=0 时不渲染。 -->
      <div v-if="thresholds.greetRed > 0" class="card" :style="{ background: metricBg(greetRiskClass) }">
        <div class="card-kicker">{{ t('risk.todayGreet') }}</div>
        <div class="mv">{{ risk.metrics.greetCountToday }}</div>
        <div class="ms">{{ t('risk.thresholdYellow', { y: thresholds.greetYellow, r: thresholds.greetRed }) }}</div>
      </div>
      <div class="card" :style="{ background: metricBg(browseRiskClass) }">
        <div class="card-kicker">{{ t('risk.todayBrowse') }}</div>
        <div class="mv">{{ risk.metrics.browseCountToday }}</div>
        <div class="ms">{{ t('risk.thresholdYellow', { y: thresholds.browseYellow, r: thresholds.browseRed }) }}</div>
      </div>
      <div class="card" v-if="risk.metrics.lastHourOps >= thresholds.freqOps * 0.7" :style="{ background: 'var(--color-accent-100)' }">
        <div class="card-kicker">{{ t('risk.freqAnomaly') }}</div>
        <div class="mv">{{ risk.metrics.lastHourOps }}</div>
        <div class="ms">{{ t('risk.freqCardMs', { win: thresholds.freqWindowSec / 60, ops: thresholds.freqOps }) }}</div>
      </div>
      <div class="card" :style="{ background: metricBg(loadRiskClass) }">
        <div class="card-kicker">{{ t('risk.requestFreq', { mode: store.activePlatform === 'liepin' ? t('risk.freqPaged') : t('risk.freqScroll') }) }}</div>
        <div class="mv">{{ risk.metrics.lastWindowLoads }}</div>
        <div class="ms">{{ t('risk.loadCardMs', { win: thresholds.freqWindowSec / 60, y: thresholds.loadFreqOps, r: thresholds.loadFreqOps * 2 }) }}</div>
      </div>
      <div class="card" v-if="risk.metrics.pageAnomaly" :style="{ background: 'var(--color-accent-200)' }">
        <div class="card-kicker">{{ t('risk.pageAnomaly') }}</div><div class="mv">{{ t('risk.yes') }}</div><div class="ms">{{ t('risk.pageAnomalyDesc') }}</div>
      </div>
      <div class="card" v-if="risk.metrics.accountRestricted" :style="{ background: 'var(--color-accent-200)' }">
        <div class="card-kicker">{{ t('risk.accountRestricted') }}</div><div class="mv">{{ t('risk.yes') }}</div><div class="ms">{{ t('risk.accountRestrictedDesc') }}</div>
      </div>
      <div class="card" v-if="risk.metrics.nightActivity" :style="{ background: 'var(--color-accent-100)' }">
        <div class="card-kicker">{{ t('risk.nightActivity') }}</div><div class="mv">{{ t('risk.yes') }}</div><div class="ms">{{ t('risk.nightActivityDesc', { start: thresholds.nightStartHour, end: thresholds.nightEndHour }) }}</div>
      </div>
    </div>

    <!-- D5(2026-08-05)：正在监控的风控信号 —— 改成后果导向（TA 看得懂），技术信号名移到 tooltip -->
    <div class="card" style="margin-bottom:18px">
      <div class="card-kicker" style="margin-bottom:10px">
        {{ t('risk.signalMonitor', { platform: store.activePlatform === 'liepin' ? t('risk.platformLiepin') : t('risk.platformBoss') }) }}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12.5px">
        <div v-for="d in defenseLayers" :key="d.label" style="display:flex;gap:8px;align-items:flex-start">
          <span class="tag" style="font-size:11px;white-space:nowrap" :title="d.k">{{ d.label }}</span>
          <span style="color:var(--color-neutral-700)">{{ d.d }}</span>
        </div>
      </div>
    </div>

    <!-- 猎聘三重配额进度条（翻页 / 搜索 / 看简历） -->
    <div v-if="store.activePlatform === 'liepin'" class="card" style="margin-bottom:18px">
      <div class="card-kicker" style="margin-bottom:14px">{{ t('risk.lpQuotaTitle') }}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px">
        <div v-for="q in liepinQuotas" :key="q.label">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-size:13px;font-weight:600">{{ q.label }}</span>
            <span style="font-size:12px;color:var(--color-neutral-600)">
              <span :style="{ color: q.limitNum > 0 && q.usedNum >= q.limitNum ? 'var(--color-accent)' : 'inherit', fontWeight: q.limitNum > 0 && q.usedNum >= q.limitNum ? 700 : 400 }">{{ q.used }}</span>
              <span> / {{ q.limit }}</span>
            </span>
          </div>
          <div style="height:8px;border-radius:6px;background:var(--color-neutral-200);overflow:hidden">
            <div :style="{
              width: Math.min(100, q.limitNum ? (q.usedNum / q.limitNum) * 100 : 0) + '%',
              height: '100%',
              borderRadius: '6px',
              background: q.limitNum > 0 && q.usedNum >= q.limitNum ? 'var(--color-accent)' : q.limitNum > 0 && q.usedNum / q.limitNum > 0.7 ? '#e6a817' : 'var(--color-accent-600)',
              transition: 'width .4s ease',
            }"></div>
          </div>
          <div style="font-size:11px;color:var(--color-neutral-600);margin-top:4px">
            {{ t('risk.lpQuotaRealCap') }}
          </div>
        </div>
      </div>
    </div>

    <!-- 近 7 天趋势 -->
    <div class="card" style="margin-bottom:18px">
      <div class="card-kicker">{{ t('risk.weekTrend') }}</div>
      <div style="display:flex;align-items:flex-end;gap:14px;height:120px;padding:14px 6px 0;border-bottom:1px solid var(--color-divider)">
        <div v-for="d in history.daily" :key="d.date" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
          <span v-if="d.count > 0" style="font-size:11px;color:var(--color-accent-700);font-weight:700;margin-bottom:3px">{{ d.count }}</span>
          <div :style="{ height: barHeight(d.count) + 'px', width: '26px', borderRadius: '6px 6px 0 0', background: d.count ? 'var(--color-accent)' : 'var(--color-neutral-300)', opacity: d.count ? 1 : 0.5 }"></div>
          <div style="font-size:11px;color:var(--color-neutral-600);margin-top:6px">{{ d.date.slice(5) }}</div>
        </div>
        <div v-if="!history.daily.length" class="fhint">{{ t('risk.noData') }}</div>
      </div>
    </div>

    <!-- 建议 -->
    <div class="card" style="margin-bottom:18px" v-if="risk.suggestions?.length">
      <div class="card-kicker">{{ t('risk.suggestions') }}</div>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--color-neutral-800);line-height:1.9">
        <li v-for="(s, i) in risk.suggestions" :key="i">{{ s }}</li>
      </ul>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../../stores/app';
import type { RiskThresholds } from '../../../../shared/types';
import { DEFAULT_RISK_THRESHOLDS } from '../../../../shared/constants';
const { t } = useI18n();

const store = useAppStore();
const risk = computed(() => store.riskState);
// 阈值优先取后端【实际生效】的（按档位自动固定），回退到设置里读到的默认；不再可编辑。
const settingsRisk = ref<RiskThresholds>(DEFAULT_RISK_THRESHOLDS);
const thresholds = computed<RiskThresholds>(() => risk.value.thresholds || settingsRisk.value);

// 各平台【实际在监控】的信号说明。必须按平台分开：
// 原来这块是 BOSS 硬编码常量，切到猎聘仍显示「API code:35」「Boss端环境检测 100xx」
// 「网易易盾」—— 而猎聘真正监控的 WAF 挑战、腾讯防水墙、境外 IP 拦截、请求超时
// 一条都没展示。用户会以为猎聘在监控 code:35（实际没有），也不知道 WAF 才是头号信号。
// D5(2026-08-05)：改成后果导向标签（TA 看得懂），原始技术信号名移到 k 字段做 tooltip
const defenseLayers = computed(() => (store.activePlatform === 'liepin' ? [
  { label: t('risk.lp_sig_robot'), k: '阿里云 WAF（acw_sc__v2/v3 挑战 cookie）', d: t('risk.lp_sig_robot_d') },
  { label: t('risk.lp_sig_ip'), k: '境外 IP 拦截（/secure/intercept-abroad-ip）', d: t('risk.lp_sig_ip_d') },
  { label: t('risk.lp_sig_captcha'), k: '腾讯防水墙 / 极验滑块（captcha.gtimg.com / geetest_*）', d: t('risk.lp_sig_captcha_d') },
  { label: t('risk.lp_sig_frozen'), k: '账号封禁文案', d: t('risk.lp_sig_frozen_d') },
  { label: t('risk.lp_sig_ratelimit'), k: 'HTTP 403/429（含主文档）', d: t('risk.lp_sig_ratelimit_d') },
  { label: t('risk.lp_sig_timeout'), k: '超时丢包（UA/TLS 识别隐蔽信号）', d: t('risk.lp_sig_timeout_d') },
  { label: t('risk.lp_sig_envreport'), k: '安全 JS 上报（security.min.js → statistic.liepin.com）', d: t('risk.lp_sig_envreport_d') },
  { label: t('risk.lp_sig_empty'), k: '连续 0 卡片返回', d: t('risk.lp_sig_empty_d') },
  { label: t('risk.lp_sig_quota'), k: '配额耗尽提示', d: t('risk.lp_sig_quota_d') },
] : [
  { label: t('risk.boss_sig_ipsession'), k: 'API code:35', d: t('risk.boss_sig_ipsession_d') },
  { label: t('risk.boss_sig_captcha'), k: '极验 / 网易易盾（滑块/点选 DOM）', d: t('risk.boss_sig_captcha_d') },
  { label: t('risk.boss_sig_env'), k: 'Boss端 100xx 静默上报', d: t('risk.boss_sig_env_d') },
  { label: t('risk.boss_sig_ratelimit'), k: 'HTTP 403/429（wapi 接口）', d: t('risk.boss_sig_ratelimit_d') },
  { label: t('risk.boss_sig_restricted'), k: '账号限制/冻结文案', d: t('risk.boss_sig_restricted_d') },
  { label: t('risk.boss_sig_nodata'), k: '多屏空数据', d: t('risk.boss_sig_nodata_d') },
]));

// 猎聘三重配额进度条数据（翻页 / 搜索 / 看简历）
// 值从 RiskMetrics 取，无值显示 "—" 而非假数字
const liepinQuotas = computed(() => {
  const m = risk.value.metrics;
  const fmt = (v: number | null | undefined): string => (v != null ? String(v) : '—');
  const usedPages = m?.pagesToday;
  const usedSearches = m?.searchesToday;
  const usedDetails = m?.detailsToday;
  // liepinDetailCap(safe, 专业版) = 15；从 adapter 下推的真实限额，未设置时显示 —
  const limitPages = m?.pagesLimit;
  const limitSearches = m?.searchesLimit;
  const limitDetails = m?.detailsLimit;
  return [
    { label: t('risk.lpQuotaPages'),   used: fmt(usedPages),     limit: fmt(limitPages),     usedNum: usedPages ?? 0,     limitNum: limitPages ?? 0 },
    { label: t('risk.lpQuotaSearches'), used: fmt(usedSearches), limit: fmt(limitSearches), usedNum: usedSearches ?? 0, limitNum: limitSearches ?? 0 },
    { label: t('risk.lpQuotaDetails'), used: fmt(usedDetails),   limit: fmt(limitDetails),  usedNum: usedDetails ?? 0,  limitNum: limitDetails ?? 0 },
  ];
});

const history = ref<{ daily: { date: string; count: number }[]; events: { id: number; time: number; date: string; level: string; reason: string }[] }>({ daily: [], events: [] });


// ── 风险指数 ──────────────────────────────────────────────────────────
const EMPTY_INDEX = {
  index: 0, band: 'steady' as const, bandLabel: t('risk.bandSteady'), action: t('risk.bandSteadyAction'),
  dimensions: [] as any[], topDrivers: [] as string[], computedAt: 0,
};
const idx = computed(() => risk.value.riskIndex || EMPTY_INDEX);
const BAND_STYLE: Record<string, { col: string; bg: string }> = {
  steady:   { col: 'var(--color-accent-2-600)', bg: 'var(--color-accent-2-100)' },
  watch:    { col: 'var(--color-accent)',       bg: 'var(--color-accent-100)' },
  converge: { col: 'var(--color-accent-800)',   bg: 'var(--color-accent-100)' },
  retreat:  { col: 'var(--color-accent-800)',   bg: 'var(--color-accent-200)' },
};
const idxBand = computed(() => BAND_STYLE[idx.value.band] || BAND_STYLE.steady);
function expColor(v: number): string {
  return v >= 70 ? 'var(--color-accent-800)' : v >= 40 ? 'var(--color-accent)' : 'var(--color-accent-2-600)';
}

// 精密防范模型：冷却剩余分钟（本地每 15s 更新一次，让倒计时活起来；冷却到点由主进程广播清除）
const nowTs = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
const cooldownLeftMin = computed(() => {
  const until = risk.value.cooldown?.until || 0;
  const left = until - nowTs.value;
  return left > 0 ? Math.ceil(left / 60000) : 0;
});
function metricBg(cls: string) { return cls === 'danger' ? 'var(--color-accent-200)' : cls === 'warning' ? 'var(--color-accent-100)' : cls === 'success' ? 'var(--color-accent-2-100)' : 'var(--color-surface)'; }

function barHeight(count: number): number { const max = Math.max(1, ...history.value.daily.map((d) => d.count)); return Math.max(4, Math.round((count / max) * 80)); }
async function loadHistory() { try { history.value = await window.api.getRiskHistory(store.activePlatform); } catch { /* ignore */ } }

const greetRiskClass = computed(() => risk.value.metrics.greetCountToday >= thresholds.value.greetRed ? 'danger' : risk.value.metrics.greetCountToday >= thresholds.value.greetYellow ? 'warning' : 'success');
const browseRiskClass = computed(() => risk.value.metrics.browseCountToday >= thresholds.value.browseRed ? 'danger' : risk.value.metrics.browseCountToday >= thresholds.value.browseYellow ? 'warning' : '');
const loadRiskClass = computed(() => {
  const n = risk.value.metrics.lastWindowLoads || 0;
  const y = thresholds.value.loadFreqOps;
  return n >= y * 2 ? 'danger' : n >= y ? 'warning' : 'success';
});


const clearing = ref(false);
// 2026-08-07 P1-8: 按返回值给准确提示，熔断仍开时提示剩余冷却，不说"可以继续开跑"
// H1(阶段1):必须传 store.activePlatform——主进程 safePlatform(undefined) 会兜底成 'boss'，
// 猎聘 tab 点「解除停机」会清掉 BOSS 的异常闩+熔断、还可能把 paused 的 BOSS 引擎放出去跑，
// 而猎聘自己永远解不掉。写回 store 前校验：请求期间用户没切到别的 tab 才写（防异步返回污染）。
async function clearRisk() {
  if (clearing.value) return;
  clearing.value = true;
  const platform = store.activePlatform;
  try {
    const st = await window.api.clearRisk(platform);
    if (st && store.activePlatform === platform) store.riskState = st;
    await loadHistory();
    if (st?.circuitOpen) {
      const remMin = Math.ceil((st.cooldownRemainingMs || 0) / 60000);
      ElMessage.warning({
        message: t('risk.msgClearCircuit', { when: remMin > 0 ? t('risk.msgClearWhenMin', { n: remMin }) : t('risk.msgClearWhenSoon') }),
        duration: 8000,
      });
    } else {
      ElMessage.success(t('risk.msgClearOk'));
    }
  } catch (e: any) {
    // D4(2026-08-05)：catch 绝不能空 —— 这是唯一的解除入口，静默失败会让 TA 反复点
    ElMessage.error({
      message: t('risk.msgClearFail', { reason: e?.message || t('risk.msgClearFailFallback') }),
      duration: 8000,
    });
  } finally {
    clearing.value = false;
  }
}

async function refresh() { try { const s = await window.api.getSettings(); if (s?.risk) settingsRisk.value = s.risk; } catch { /* 读设置失败则保持默认 */ } await loadHistory(); }
// H1(阶段1):切平台时重载该平台的风险历史——对齐 RpaPage.vue 的 watch 范式。
// 不重载的话切到猎聘 tab 看到的还是 BOSS 的历史，反过来同理。
watch(() => store.activePlatform, () => { loadHistory(); });

onMounted(async () => { await refresh(); nowTimer = setInterval(() => { nowTs.value = Date.now(); }, 15000); });
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });
</script>

<style scoped>
.mv { font-family: var(--font-heading); font-size: 30px; line-height: 1; margin: 8px 0 6px; }
.mv2 { font-family: var(--font-heading); font-size: 20px; line-height: 1.1; margin: 6px 0 2px; }
.ms { font-size: 11.5px; color: var(--color-neutral-600); }
</style>
