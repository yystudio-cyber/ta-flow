<template>
  <div class="page-wrap">
    <!-- 双平台 Tab 切换（D6: 走 store.setActivePlatform 持久化，与侧边栏全局切换器同步） -->
    <div class="tabs-bar" style="margin-bottom:14px">
      <button v-for="p in platforms" :key="p" type="button"
        class="tab" :class="{ active: store.activePlatform === p }"
        @click="switchPlat(p)">
        {{ platformLabel(p) }}
      </button>
    </div>

    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
      <h1 class="page-h1" style="flex:1">{{ t('rpa.title') }}</h1>
      <span style="font-size:13px;color:var(--color-neutral-700)">{{ t('rpa.findingPosition') }}</span>
      <select class="input" v-model="selectedJdId" style="width:240px" :disabled="isRunning">
        <option disabled value="">{{ t('rpa.selectJd') }}</option>
        <option v-for="j in jds" :key="j.id" :value="j.id">{{ j.name }}</option>
      </select>
      <button v-if="!isRunning" type="button" class="btn btn-primary" @click="startRpa">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"></path></svg>{{ t('rpa.startHunt') }}
      </button>
      <!-- ★ 自定义任务入口冻结（后续开放）：现阶段 RPA 完全按岗位库激活 JD 自主找人，无需用户配任务。 -->
      <button v-if="!isRunning" type="button" class="btn btn-ghost" @click="newTask" :title="t('rpa.newTaskTip')" style="opacity:.5;pointer-events:none">{{ t('rpa.newTask') }}</button>
      <button v-if="state.status === 'running'" type="button" class="btn btn-secondary" @click="pause">{{ t('rpa.pause') }}</button>
      <button v-if="state.status === 'paused'" type="button" class="btn btn-primary" @click="resume">{{ t('rpa.resume') }}</button>
      <button v-if="isRunning" type="button" class="btn btn-ghost" @click="stop">{{ t('rpa.stop') }}</button>
    </div>
    <p v-if="!jds.length" style="margin:0 0 18px;font-size:13px;color:var(--color-accent-700)">
      {{ t('rpa.noJdPre') }}<a href="#/match" style="color:var(--color-accent)">{{ t('nav.match') }}</a>{{ t('rpa.noJdPost') }}
    </p>

    <div class="card" style="margin-bottom:18px">
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;align-items:center">
        <div>
          <div class="card-kicker">{{ t('rpa.status') }}</div>
          <div style="display:flex;align-items:center;gap:9px;margin-top:8px">
            <span style="width:10px;height:10px;border-radius:999px" :style="{ background: dotCol, animation: dotAnim }"></span>
            <span style="font-family:var(--font-heading);font-size:20px">{{ statusLabel }}</span>
          </div>
        </div>
        <div><div class="card-kicker">{{ t('rpa.elapsed') }}</div><div class="m-val" style="font-variant-numeric:tabular-nums">{{ formatElapsed }}</div></div>
        <div><div class="card-kicker">{{ t('rpa.viewed') }}</div><div class="m-val">{{ todayStats.viewed }} <span class="m-sub">{{ t('rpa.people') }}</span></div></div>
        <div><div class="card-kicker">{{ t('rpa.todayGreet') }}</div><div class="m-val">{{ todayStats.greeted }} <span class="m-sub">/ {{ currentTask?.speed.dailyGreetLimit || 100 }} {{ t('rpa.limit') }}</span></div></div>
        <div><div class="card-kicker">{{ t('rpa.favorited') }}</div><div class="m-val">{{ todayStats.favorited }} <span class="m-sub">{{ t('rpa.people') }}</span></div></div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--color-neutral-200);font-size:12.5px;color:var(--color-neutral-700)">{{ t('rpa.currentPage') }}：{{ state.currentPage || (isRunning ? t('rpa.pageSearching') : t('rpa.pageNotRunning')) }}</div>
    </div>
    <p v-if="isRunning" style="margin:-8px 0 16px;font-size:12.5px;color:var(--color-accent-700)">
      {{ t('rpa.manualTip') }}
    </p>

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:18px;align-items:start">
      <div class="log-panel">
        <div class="log-head">
          <span>{{ t('rpa.realtimeLog') }}</span><span style="flex:1"></span>
          <span style="font-variant-numeric:tabular-nums">{{ state.logs.length }} {{ t('rpa.logCount') }}</span>
          <span class="log-clear" @click="clearLogs">{{ t('rpa.clearLog') }}</span>
        </div>
        <div class="log-body">
          <div v-for="(l, i) in [...state.logs].reverse()" :key="i" class="log-line">
            <span class="log-t">{{ formatTime(l.time) }}</span>
            <span :style="{ color: logCol(l.level) }">{{ l.message }}</span>
          </div>
          <div v-if="!state.logs.length" class="log-line"><span class="log-t">—</span><span style="opacity:.5">{{ t('rpa.logEmpty') }}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-kicker">{{ t('rpa.currentTaskCfg') }}</div>
        <div v-if="currentTask" style="display:grid;gap:13px;margin-top:14px;font-size:13px">
          <div><div class="cfg-lab">{{ t('rpa.taskName') }}</div><strong>{{ currentTask.name }}</strong>
            <!-- ★ 自定义任务入口冻结（后续开放）：编辑/删除隐藏，RPA 按激活 JD 自动建/复用任务。 -->
          </div>
          <div>
            <div class="cfg-lab">{{ t('rpa.speedMode') }}</div>
            <!-- ★ 2026-08-20 P2：净删 safe 档，只留 human（猎聘真实配额档）。恒定真人档，只读展示。 -->
            <div class="seg">
              <label class="seg-opt" style="opacity:.55"><input type="radio" checked disabled />{{ t('rpa.speedHuman') }}</label>
            </div>
          </div>
          <div style="display:flex;gap:14px;font-size:12.5px;color:var(--color-neutral-700);flex-wrap:wrap">
            <span>{{ t('rpa.dailyGreet') }} {{ currentTask.speed.dailyGreetLimit }}</span>
            <span>{{ t('rpa.dailyBrowse') }} {{ currentTask.speed.dailyBrowseLimit }} {{ t('rpa.peopleSuffix') }}</span>
            <span>{{ t('rpa.dailyFavorite') }} {{ favoriteLimit }}</span>
            <span>{{ currentTask.schedule.runDurationMin ? currentTask.schedule.runDurationMin + ' ' + t('rpa.runDurationMin') : t('rpa.noDurationLimit') }}</span>
          </div>
        </div>
        <div v-else style="margin-top:14px;font-size:13px;color:var(--color-neutral-600)">
          {{ t('rpa.noTaskHint') }}
        </div>
      </div>
    </div>

    <!-- 新建/编辑任务 弹窗 -->
    <div v-if="dialogVisible" class="dialog-backdrop" @click.self="dialogVisible = false">
      <div class="dialog" style="width:min(560px,100%);max-height:88vh;overflow:auto">
        <div class="dialog-title">{{ editingTask ? t('rpa.dialogEdit') : t('rpa.dialogNew') }}</div>
        <div style="display:grid;gap:12px">
          <div class="field"><label>{{ t('rpa.fldTaskName') }}</label><input class="input" v-model="form.name" :placeholder="t('rpa.fldTaskNamePh')" /></div>
          <!-- ★ 自定义搜索条件入口冻结（后续开放）：现阶段 RPA 完全按岗位库激活 JD 自主找人，
               BOSS/猎聘两平台界面一致，不再暴露平台专属的搜索条件配置。 -->
          <div class="fhint" style="padding:10px 12px;background:var(--color-neutral-100);border-radius:8px;line-height:1.7;margin-bottom:4px">
            {{ t('rpa.taskFrozenHint') }}
          </div>
          <!-- 当前版本为【列表级零写操作】模式：只读推荐卡评分落库，不点开详情、不收藏、不打招呼。
               打招呼/收藏的发送流程尚未在真机验证（见 platform-adapter.tryGreet 注释），
               且风险登记册把 auto-greet 默认关列为刑事与声誉双重护栏。
               这两个开关在引擎里走的是深挖分支，当前不会被执行——故置灰并如实说明，
               而不是让用户勾了以为生效。 -->
          <label class="radio" style="opacity:.55;cursor:not-allowed"><input type="checkbox" v-model="form.actions.autoGreet" disabled /><span class="dot"></span>{{ t('rpa.autoGreetInline', { n: form.actions.greetThreshold }) }}</label>
          <label class="radio" style="opacity:.55;cursor:not-allowed"><input type="checkbox" v-model="form.actions.autoFavorite" disabled /><span class="dot"></span>{{ t('rpa.autoFavInline', { n: form.actions.favoriteThreshold }) }}</label>
          <div class="fhint" style="margin:-4px 0 8px" v-html="t('rpa.zeroWriteHint')"></div>
          <div class="field"><label>{{ t('rpa.speedGear') }}</label>
            <!-- ★ 2026-08-20 P2：净删 safe 档，只留 human。恒定真人档（猎聘真实配额档），只读展示，
                 不再有 safe/human 选择。功能（启停/搜索/深翻/页深/去重/拟人/反风控/监控）一律不动。 -->
            <div class="seg">
              <label class="seg-opt" style="opacity:.55"><input type="radio" value="human" v-model="form.speed.mode" disabled />{{ t('rpa.speedHumanGear') }}</label>
            </div>
            <!-- 2026-08-07 P1-3: 用 form.speed.dailyXxxLimit（已按平台动态取值），
                 不再硬编码 BOSS 口径，猎聘会显示 招呼0/浏览1800/收藏0 -->
            <div style="font-size:11.5px;color:var(--color-neutral-600);margin-top:4px">
              <span>{{ t('rpa.speedHumanDesc', { g: form.speed.dailyGreetLimit, b: form.speed.dailyBrowseLimit, f: form.speed.dailyFavoriteLimit }) }}</span>
            </div>
          </div>
          <div style="background:var(--color-surface-2, #f3f5f9);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--color-neutral-700);line-height:1.7">
            <span v-html="t('rpa.antiRiskPanel')"></span>
            <div style="margin-top:4px">{{ t('rpa.antiRiskDaily', { g: form.speed.dailyGreetLimit, b: form.speed.dailyBrowseLimit, f: form.speed.dailyFavoriteLimit }) }}</div>
          </div>
          <div class="field"><label>{{ t('rpa.trigger') }}</label>
            <div class="seg">
              <label class="seg-opt"><input type="radio" value="manual" v-model="form.schedule.trigger" />{{ t('rpa.triggerManual') }}</label>
              <label class="seg-opt"><input type="radio" value="schedule" v-model="form.schedule.trigger" />{{ t('rpa.triggerSchedule') }}</label>
              <label class="seg-opt"><input type="radio" value="idle" v-model="form.schedule.trigger" />{{ t('rpa.triggerIdle') }}</label>
            </div>
          </div>
          <div v-if="form.schedule.trigger==='schedule'" class="field"><label>{{ t('rpa.cronLabel') }}</label><input class="input" v-model="form.schedule.cron" :placeholder="t('rpa.cronPh')" /></div>
          <div v-if="form.schedule.trigger==='idle'" class="field"><label>{{ t('rpa.idleStart') }}</label><input class="input" type="number" v-model.number="form.schedule.idleStartMinutes" style="max-width:120px" /></div>
          <div class="field"><label>{{ t('rpa.runDuration') }}</label><input class="input" type="number" v-model.number="form.schedule.runDurationMin" style="max-width:140px" /></div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" @click="dialogVisible = false">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn-primary" @click="saveTask">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../../stores/app';
import type { RPATask, ActionConfig, SearchConfig, SpeedConfig, ScheduleConfig, JD } from '../../../../shared/types';
import { formatDuration, logTime, makeDefaultTask, getDefaultLimits } from '../../../../shared/utils';
import { PLATFORMS, type PlatformId } from '../../../../shared/types';

const { t } = useI18n();
const store = useAppStore();
const platforms = PLATFORMS as readonly PlatformId[];
const state = computed(() => store.rpaState);
const risk = computed(() => store.riskState);
const dialogVisible = ref(false);
const tasks = ref<RPATask[]>([]);
const selectedTask = ref<string | null>(null);
const editingTask = ref<RPATask | null>(null);
// RPA 直接跟岗位库联动：用户选一个岗位 → 开始找人（不再管"任务"）
const jds = ref<JD[]>([]);
const selectedJdId = ref<string>('');

const currentTask = computed(() => {
  const id = state.value.taskId || selectedTask.value;
  return tasks.value.find((t) => t.id === id) || null;
});
const isRunning = computed(() => ['running', 'paused'].includes(state.value.status));
const todayStats = computed(() => {
  const m = risk.value.metrics;
  return {
    viewed: m?.browseCountToday ?? state.value.stats.viewed,
    greeted: m?.greetCountToday ?? state.value.stats.greeted,
    favorited: m?.favoriteCountToday ?? state.value.stats.favorited,
  };
});
const favoriteLimit = computed(() => currentTask.value?.speed.dailyFavoriteLimit || '—');
// 平台显示名（BOSS 恒为拉丁名；猎聘按语言译）。与 Sidebar 一致。
function platformLabel(p: PlatformId) { return p === 'liepin' ? t('common.liepin') : 'BOSS'; }

// 把每日上限同步为 human 档的固定值（反风控自动、不可手填）
// ★ 2026-08-20 P2：唯一 human 档，不再按档位切换。旧 safe 任务归一为 human 后调此同步上限。
// 2026-08-07 P1-3: 补传 platform，猎聘的上限与 BOSS 不同（greet=0, browse=1800, fav=0）
function applyModeCaps() {
  const caps = getDefaultLimits('human', store.activePlatform);
  form.value.speed.dailyGreetLimit = caps.greet;
  form.value.speed.dailyBrowseLimit = caps.browse;
  form.value.speed.dailyFavoriteLimit = caps.favorite;
}

// 2026-08-07 P1-3: defaultForm 改为按当前平台取默认值，不再硬编码 15/240/40（BOSS 口径）。
// 猎聘的上限是 0/1800/0，硬编码会让任务表单与实际门控不一致。
function defaultForm(): RPATask & { search: SearchConfig; actions: ActionConfig; speed: SpeedConfig; schedule: ScheduleConfig } {
  const p = store.activePlatform;
  const caps = getDefaultLimits('human', p);
  return {
    id: '', name: '', platform: p,
    search: {
      keywords: '', city: '杭州', experience: '3-5年', degree: '本科', salary: '',
      keywordGroups: [], cities: [] as string[], industries: [] as string[], targetCompanies: [] as string[], strictFilters: true,
    },
    actions: { autoGreet: false, greetThreshold: 75, greetTemplate: '您好，看到您的经历很匹配，方便聊聊吗？', autoFavorite: false, favoriteThreshold: 70, exportCsv: true },
    speed: { mode: 'human', dailyGreetLimit: caps.greet, dailyBrowseLimit: caps.browse, dailyFavoriteLimit: caps.favorite },
    schedule: { trigger: 'manual', runDurationMin: 90, cron: '', idleStartMinutes: 5, idlePauseOnInput: true },
    createdAt: 0, updatedAt: 0,
  };
}
const form = ref(defaultForm());

const statusLabel = computed(() => ({
  idle: t('rpa.statusIdle'),
  running: t('rpa.statusRunning'),
  paused: t('rpa.statusPaused'),
  stopped: t('rpa.statusStopped'),
  error: t('rpa.statusError'),
} as Record<string, string>)[state.value.status] || state.value.status);
const dotCol = computed(() => state.value.status === 'running' ? 'var(--color-accent-2)' : state.value.status === 'paused' ? 'var(--color-accent)' : state.value.status === 'error' ? 'var(--color-accent-800)' : 'var(--color-neutral-400)');
const dotAnim = computed(() => (state.value.status === 'running' ? 'ta-pulse 1.6s ease-in-out infinite' : 'none'));
const formatElapsed = computed(() => formatDuration(state.value.elapsedMs));
function formatTime(t: number) { return logTime(new Date(t)); }
function logCol(level: string) {
  return { success: 'var(--color-accent-2-300)', error: '#f0a58c', warn: 'var(--color-accent-300)', info: 'rgba(249,244,237,0.62)' }[level] || 'rgba(249,244,237,0.62)';
}

async function loadTasks() {
  tasks.value = await window.api.listTasks(store.activePlatform);
  if (tasks.value.length && !selectedTask.value) selectedTask.value = tasks.value[0].id;
}
async function loadJds() {
  jds.value = await window.api.listJds();
  // 默认选中激活岗位，否则第一个
  const active = jds.value.find((j) => j.active);
  if (!selectedJdId.value) selectedJdId.value = active?.id || jds.value[0]?.id || '';
}
function newTask() { editingTask.value = null; form.value = defaultForm(); dialogVisible.value = true; }
function editTask(row: RPATask) {
  editingTask.value = row; form.value = JSON.parse(JSON.stringify(row));
  // ★ 2026-08-20 P2：归一化旧任务——唯一 human 档，safe/fast/slower 一律归 human + 上限同步为 human 固定值。
  form.value.speed.mode = 'human';
  applyModeCaps();
  dialogVisible.value = true;
}

// 开始找人：选中岗位 → 激活它 → 连浏览器(自动打开BOSS) → 自动建/复用任务 → 启动
async function startRpa() {
  const p = store.activePlatform;
  const jd = jds.value.find((j) => j.id === selectedJdId.value);
  if (!jd) { ElMessage.warning(t('rpa.msgSelectJd')); return; }
  try {
    if (!jd.active) { await window.api.setActiveJd(jd.id); await loadJds(); }
    // 猎聘：独立浏览器（端口 9333、独立 profile）。与 BOSS 同一套通道，只是平台参数不同。
    if (p === 'liepin') {
      // ★ 校验必须在打开浏览器【之前】。原顺序是先 openBrowserForLogin 再校验关键词，
      //   于是"任务没配关键词"这个必然失败的情况下，每点一次「开始找人」都会先把浏览器
      //   弹出来/抢一次焦点，然后才 return —— 用户看到的现象就是"一直在打开猎聘浏览器
      //   但从来不找人"，而真正的原因（缺关键词）被浏览器窗口盖住、根本没被注意到。
      //   真机日志坐实了这一点：cdp:open-for-login 3 次全成功，rpa:start 一次都没有。

      // 复用本平台已有任务；没有才新建。★ 这里依赖 loadTasks 已按平台过滤，
      //   否则会在猎聘 tab 上找不到猎聘任务、每点一次就偷偷新建一个看不见的任务。
      let taskId = tasks.value.find((tk) => tk.platform === 'liepin')?.id;
      if (!taskId) {
        const speed = (store.settings?.rpa?.defaultSpeed as any) || 'human';
        const savedTask = await window.api.saveTask(makeDefaultTask(jd.name, speed, 'liepin'));
        taskId = savedTask.id; await loadTasks();
        ElMessage.info(t('rpa.msgLiepinNewTask'));
        return;
      }
      const tk = tasks.value.find((x) => x.id === taskId);
      const kws = (tk?.search as any)?.keywordGroups || [];
      if (!kws.length) {
        ElMessage.warning(t('rpa.msgLiepinNoKw'));
        return;
      }

      // 走到这里才是真要开跑：这时再确保浏览器开着（已开则只聚焦，不再新开标签页）
      try { await window.api.openBrowserForLogin('liepin'); } catch { /* 打不开的话由下面的启动报错说明 */ }
      // ★ 必须 smartConnect：引擎里的 rt().chrome.getBrowser() 取的是【已 attach 的
      //   puppeteer 实例】，光把浏览器窗口打开它仍然是 null。BOSS 分支一直有这一步，
      //   猎聘分支漏了 —— 表现就是 2026-08-05 真机日志里那两条
      //   「RPA 启动」紧跟着「运行出错：浏览器未连接」：启动流程通了，但从没连上过浏览器。
      if (!store.cdpConnected) {
        try {
          await window.api.smartConnect('liepin');
        } catch (e: any) {
          ElMessage.error(e?.message || t('rpa.msgLiepinConnFail'));
          return;
        }
      }
      await window.api.startRpa(taskId, 'liepin');
      // ★ 回检真实状态再报成功。原实现无条件 success：引擎启动后立刻失败（登录失效、
      //   选择器全挂、风控闩未解）时，界面照样显示"开始找人了"，而实际什么都没跑——
      //   这类"报喜不报忧"比直接报错更难查。与 BOSS 分支保持同一套判定。
      await new Promise((r) => setTimeout(r, 1500));
      const lst = state.value?.status;
      if (lst === 'running' || lst === 'paused') {
        ElMessage.success(t('rpa.msgLiepinStarted', { name: jd.name }));
      } else {
        const lastErr = [...(state.value?.logs || [])].reverse().find((l: any) => l.level === 'error');
        ElMessage.error(lastErr?.message || t('rpa.msgLiepinStartFail'));
      }
      return;
    }
    // BOSS 流程（保持原逻辑不变）
    if (!store.cdpConnected) {
      try {
        await window.api.openBrowserForLogin();
        await window.api.smartConnect();
      } catch (e: any) {
        ElMessage.error(e?.message || t('rpa.msgBrowserFail'));
        return;
      }
    } else {
      try { await window.api.openBrowserForLogin(); } catch { /* 前置失败不阻断 */ }
    }
    let taskId = tasks.value[0]?.id;
    if (!taskId) {
      const speed = (store.settings?.rpa?.defaultSpeed as any) || 'human';
      const savedTask = await window.api.saveTask(makeDefaultTask(jd.name, speed));
      taskId = savedTask.id; await loadTasks();
    }
    await window.api.startRpa(taskId);
    await new Promise((r) => setTimeout(r, 1500));
    const st = state.value?.status;
    if (st === 'running' || st === 'paused') {
      ElMessage.success(t('rpa.msgBossStarted', { name: jd.name }));
    } else {
      const lastErr = [...(state.value?.logs || [])].reverse().find((l: any) => l.level === 'error');
      ElMessage.error(lastErr?.message || t('rpa.msgStartFail'));
    }
  } catch (e: any) { ElMessage.error(e.message || t('rpa.msgStartFailed')); }
}
// D4(2026-08-05)：暂停/继续/停止必须 await + 明确反馈——这是 TA 最需要"立刻停下"确定感的按钮。
// 原实现裸调不 await，IPC 抛异常时"点了完全没反应"，TA 会反复点、以为软件坏了。
// ★ P2-5(2026-08-11): 全部补传当前平台，避免在猎聘 tab 操作命中 BOSS 引擎。
async function pause() {
  try { await window.api.pauseRpa(store.activePlatform); ElMessage.success(t('rpa.msgPaused')); }
  catch (e: any) { ElMessage.error(t('rpa.msgPauseFail', { reason: e?.message || '' })); }
}
async function resume() {
  try { await window.api.resumeRpa(store.activePlatform); ElMessage.success(t('rpa.msgResumed')); }
  catch (e: any) { ElMessage.error(t('rpa.msgResumeFail', { reason: e?.message || '' })); }
}
async function stop() {
  try { await window.api.stopRpa(store.activePlatform); ElMessage.success(t('rpa.msgStopped')); }
  catch (e: any) { ElMessage.error(t('rpa.msgStopFail', { reason: e?.message || '' })); }
}
async function clearLogs() {
  try { await window.api.clearRpaLogs(store.activePlatform); } catch { /* 后端清空失败也先清视图 */ }
  state.value.logs = [];
}

async function saveTask() {
  if (!form.value.name) { ElMessage.warning(t('rpa.msgTaskNameRequired')); return; }
  const p = form.value.platform || store.activePlatform;
  form.value.platform = p;
  if (p === 'liepin') {
    // ★ 自定义任务入口冻结后，弹窗不再暴露关键词/城市/行业字段（后续开放）。
    //   关键词组以表单内现有值为准（defaultForm 初始化为空），保存时仍写入 search.keywordGroups。
    const groups = (form.value.search as any).keywordGroups || [];
    if (!groups.length) { ElMessage.warning(t('rpa.msgKwRequired')); return; }
  }
  // BOSS 搜索字段已置灰且 buildQueries 丢弃 SearchConfig，无需校验关键词（2026-08-05 真相）
  const saved = await window.api.saveTask(form.value as any);
  ElMessage.success(t('rpa.msgTaskSaved'));
  dialogVisible.value = false;
  editingTask.value = null;
  await loadTasks();
  selectedTask.value = saved.id;
}
async function deleteTask(id: string) {
  try {
    await ElMessageBox.confirm(t('rpa.msgConfirmDelete'), t('rpa.confirmTitle'), { type: 'warning' });
    await window.api.deleteTask(id);
    ElMessage.success(t('rpa.msgTaskDeleted'));
    if (selectedTask.value === id) selectedTask.value = null;
    await loadTasks();
  } catch { /* cancelled */ }
}
watch(() => dialogVisible.value, (v) => { if (!v) { editingTask.value = null; form.value = defaultForm(); } });
// D6(2026-08-05)：平台切换走 store.setActivePlatform（持久化），页面内 tab 只是切换器之一
function switchPlat(p: PlatformId) { void store.setActivePlatform(p); }
// ★ 切平台必须重载任务列表：任务是按平台存的，不重载会让「当前任务配置」卡片
//   显示的仍是上一个平台的任务 —— 用户在猎聘 tab 上点「编辑」，改的却是 BOSS 的任务。
watch(() => store.activePlatform, () => {
  selectedTask.value = '';
  loadTasks().catch(() => { /* 列表加载失败由页面空态体现 */ });
});
onMounted(() => { loadTasks().catch(() => { /* 列表加载失败由页面空态体现 */ }); loadJds().catch(() => { /* 岗位加载失败由空下拉体现 */ }); });
</script>

<style scoped>
.m-val { font-family: var(--font-heading); font-size: 20px; margin-top: 8px; }
.m-sub { font-size: 12px; font-family: var(--font-body); opacity: 0.55; }
.cfg-lab { font-size: 11px; opacity: 0.55; margin-bottom: 4px; }
.log-panel { background: var(--panel-dark); color: var(--color-neutral-100); border-radius: var(--radius-lg); padding: 18px 20px; }
.log-head { display: flex; align-items: center; gap: 10px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7; margin-bottom: 12px; color: #f9f4ed; }
.log-clear { cursor: pointer; opacity: 0.7; text-transform: none; letter-spacing: 0; }
.log-clear:hover { opacity: 1; color: var(--color-accent-300); }
.log-body { height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.log-line { display: flex; gap: 12px; padding: 4px 2px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; }
.log-t { opacity: 0.45; flex: none; font-variant-numeric: tabular-nums; color: #f9f4ed; }
.dialog-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--color-neutral-900) 50%, transparent); z-index: 100; }
.dialog { display: flex; flex-direction: column; gap: 13px; padding: 20px 22px; border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-lg); }
.dialog-title { font-family: var(--font-heading); font-size: 20px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
/* D5(2026-08-05)：开发细节默认折叠 */
.probe-dev summary::-webkit-details-marker { display: none; }
.probe-dev[open] summary { margin-bottom: 4px; }
</style>
