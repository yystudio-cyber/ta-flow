<template>
  <div class="page-wrap">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px">
      <h1 class="page-h1" style="flex:1">{{ t('settings.title') }}</h1>
      <button type="button" class="btn btn-primary" :disabled="!dirty" @click="save">{{ t('settings.save') }}</button>
    </div>

    <div class="tabs-bar">
      <button v-for="tb in tabs" :key="tb.k" class="tab" :class="{ active: activeTab === tb.k }" @click="activeTab = tb.k">{{ tb.label }}</button>
    </div>

    <!-- 通用 -->
    <div v-show="activeTab === 'general'" class="card">
      <div class="frow"><label>{{ t('settings.autoLaunch') }}</label>
        <label class="switch"><input type="checkbox" v-model="form.general.autoLaunch" /><span class="track"></span><span class="thumb"></span></label></div>
      <div class="frow"><label>{{ t('settings.trayOnClose') }}</label>
        <label class="switch"><input type="checkbox" v-model="form.general.trayOnClose" /><span class="track"></span><span class="thumb"></span></label>
        <span class="fhint">{{ t('settings.trayOnCloseHint') }}</span></div>
      <div class="frow"><label>{{ t('settings.theme') }}</label>
        <div class="seg">
          <label class="seg-opt"><input type="radio" value="light" v-model="form.general.theme" />{{ t('settings.themeLight') }}</label>
          <label class="seg-opt"><input type="radio" value="dark" v-model="form.general.theme" />{{ t('settings.themeDark') }}</label>
          <label class="seg-opt"><input type="radio" value="system" v-model="form.general.theme" />{{ t('settings.themeSystem') }}</label>
        </div></div>
      <!-- 语言下拉：原先 disabled 写死"简体中文"，现在接 form.general.language，保存即生效切换 -->
      <div class="frow"><label>{{ t('settings.language') }}</label>
        <select class="input" style="width:160px" v-model="form.general.language">
          <option v-for="loc in SUPPORTED_LOCALES" :key="loc.value" :value="loc.value">{{ loc.label }}</option>
        </select>
        <span class="fhint">{{ t('settings.languageHint') }}</span></div>
    </div>

    <!-- 浏览器（真实用户只需一键连接；其余折叠进高级） -->
    <div v-show="activeTab === 'browser'" class="card">
      <!-- 一键连接：大按钮 + 状态 -->
      <div style="display:flex;align-items:center;gap:16px;padding:6px 2px 14px">
        <button type="button" class="btn btn-primary" style="font-size:15px;padding:12px 26px" @click="launchBrowser">{{ t('settings.openBossBrowser') }}</button>
        <div style="display:flex;align-items:center;gap:9px">
          <span style="width:9px;height:9px;border-radius:999px" :style="{ background: (cdpConnected || browserOpen) ? 'var(--color-accent-2)' : 'var(--color-neutral-400)' }"></span>
          <span style="font-size:14px">{{ cdpConnected ? t('settings.statusConnected') : browserOpen ? t('settings.statusOpened') : t('settings.statusNotOpen') }}</span>
        </div>
      </div>
      <div class="fhint" style="margin:-6px 0 2px">{{ t('settings.browserLoginHint') }}</div>

      <!-- 猎聘浏览器（独立端口 9333 + 独立 profile） -->
      <div style="display:flex;align-items:center;gap:16px;padding:6px 2px 14px;border-top:1px solid var(--color-neutral-200);margin-top:10px;padding-top:14px">
        <button type="button" class="btn btn-secondary" style="font-size:14px;padding:10px 22px" @click="launchLiepinBrowser">{{ t('settings.openLiepinBrowser') }}</button>
        <!-- 猎聘状态灯：原来这行只有一句静态说明，没有任何状态反馈——
             猎聘浏览器开没开、登没登上，界面上一个字都看不到，只能去看 BOSS 那盏灯，
             而那盏灯读的是 BOSS 的状态。这是"打开并登录了却显示未打开"的直接原因之一。 -->
        <div style="display:flex;align-items:center;gap:9px">
          <span style="width:9px;height:9px;border-radius:999px"
            :style="{ background: liepinOpen ? 'var(--color-accent-2)' : 'var(--color-neutral-400)' }"></span>
          <span style="font-size:14px">{{ liepinOpen ? t('settings.liepinOpened') : t('settings.liepinNotOpen') }}</span>
        </div>
        <span style="font-size:13px;color:var(--color-neutral-600)">{{ t('settings.liepinIsolation') }}</span>
      </div>

      <!-- 高级设置（默认折叠） -->
      <div class="divider" style="cursor:pointer;margin-top:16px" @click="showBrowserAdv = !showBrowserAdv">{{ t('settings.advanced') }} {{ showBrowserAdv ? '▲' : '▼' }}</div>
      <template v-if="showBrowserAdv">
        <div class="frow"><label>{{ t('settings.connMode') }}</label>
          <div class="seg">
            <label class="seg-opt"><input type="radio" value="dedicated" v-model="form.browser.mode" />{{ t('settings.modeDedicated') }}</label>
            <label class="seg-opt"><input type="radio" value="existing" v-model="form.browser.mode" />{{ t('settings.modeExisting') }}</label>
          </div></div>
        <div class="fhint" style="margin:-4px 0 4px 164px">{{ t('settings.modeHint') }}</div>
        <div class="frow" style="align-items:flex-start"><label style="padding-top:8px">{{ t('settings.chromePath') }}</label>
          <div style="flex:1;max-width:460px"><input class="input" v-model="form.browser.chromePath" :placeholder="t('settings.chromePathPh')" /></div></div>
        <!-- 端口定死：平台隔离硬约束（9222 BOSS / 9333 猎聘），readonly + 占位显示当前值，禁止用户改 -->
        <div class="frow"><label>{{ t('settings.bossCdpPort') }}</label><input class="input" type="number" :value="form.browser.cdpPort" readonly style="width:140px" /><span class="fhint">{{ t('settings.portFixed') }}</span></div>
        <div class="frow"><label>{{ t('settings.liepinCdpPort') }}</label><input class="input" type="number" :value="form.browser.liepinCdpPort" readonly style="width:140px" /><span class="fhint">{{ t('settings.portFixed') }}</span></div>
        <div class="frow" style="align-items:flex-start"><label style="padding-top:8px">{{ t('settings.extraArgs') }}</label>
          <div style="flex:1;max-width:460px"><input class="input" v-model="form.browser.extraArgs" :placeholder="t('settings.extraArgsPh')" />
            <div class="fhint" style="margin-top:4px">{{ t('settings.extraArgsHint') }}</div></div></div>
        <div class="frow" style="align-items:flex-start"><label style="padding-top:8px">{{ t('settings.bossSelectors') }}</label>
          <div style="flex:1;max-width:460px"><textarea class="input" rows="3" v-model="form.browser.bossSelectors" :placeholder="t('settings.bossSelectorsPh')"></textarea></div></div>
        <div class="frow" style="align-items:flex-start"><label style="padding-top:8px">{{ t('settings.liepinSelectors') }}</label>
          <div style="flex:1;max-width:460px"><textarea class="input" rows="3" v-model="form.browser.liepinSelectors" :placeholder="t('settings.liepinSelectorsPh')"></textarea>
            <div class="fhint" style="margin-top:4px;color:var(--color-accent-700)">{{ t('settings.liepinSelectorsHint') }}</div></div></div>
      </template>
    </div>

    <!-- RPA / 风险 / 匹配评分 tab 前端隐藏：这三类参数（速度档、风控阈值、匹配权重）后端 DEFAULT_SETTINGS 定死，
         前端不再暴露编辑入口，避免 TA 误调触发风控或评分失真。后端契约不变，store/engine 仍读这些字段。 -->

    <!-- 数据管理 -->
    <div v-show="activeTab === 'data'" class="card">
      <div class="frow" style="align-items:flex-start"><label style="padding-top:8px">{{ t('settings.dataDir') }}</label>
        <div style="flex:1;display:flex;gap:8px;max-width:460px">
          <input class="input" v-model="form.data.dataDir" readonly />
          <button type="button" class="btn btn-secondary" style="flex:none" @click="openDataFolder">{{ t('settings.openFolder') }}</button>
        </div></div>
      <div class="frow"><label>{{ t('settings.exportDir') }}</label><input class="input" v-model="form.data.exportDir" :placeholder="t('settings.exportDirPh')" style="max-width:400px" /></div>
      <div class="frow"><label>{{ t('settings.encryption') }}</label>
        <label class="switch"><input type="checkbox" v-model="form.data.encryptionEnabled" /><span class="track"></span><span class="thumb"></span></label>
        <span class="fhint">{{ t('settings.encryptionHint') }}</span></div>

      <!-- 加密的【实际】状态。开关只代表"想不想加密"，这里代表"到底有没有在加密"——
           两者可能不一致（拿不到密钥时会静默降级为明文），必须让用户看见。 -->
      <div class="frow"><label>{{ t('settings.encActual') }}</label>
        <span v-if="enc.mode === 'on'" class="tag tag-accent-2">{{ t('settings.encOn') }}</span>
        <span v-else-if="enc.mode === 'off'" class="tag tag-neutral">{{ t('settings.encOff') }}</span>
        <span v-else class="tag tag-accent">{{ t('settings.encDegraded') }}</span>
        <button v-if="enc.mode === 'degraded'" type="button" class="btn btn-secondary" style="margin-left:10px" :disabled="encFixing" @click="fixEncryption">
          {{ encFixing ? t('settings.fixing') : t('settings.fixEncryption') }}
        </button>
      </div>
      <div v-if="enc.mode === 'degraded'" class="frow"><label></label>
        <span class="fhint" style="color:var(--color-accent-800);line-height:1.8">
          {{ t('settings.encDegradedHint', { reason: enc.reason }) }}<br />
          {{ t('settings.encDegradedCompliance') }}
        </span>
      </div>
      <div class="hr"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" @click="exportCsv">{{ t('settings.exportCsv') }}</button>
        <button type="button" class="btn btn-secondary" @click="importCandidates">{{ t('settings.importCandidates') }}</button>
        <button type="button" class="btn btn-secondary" @click="backupData">{{ t('settings.backupData') }}</button>
        <button type="button" class="btn btn-secondary" @click="restoreData">{{ t('settings.restoreData') }}</button>
        <button type="button" class="btn btn-ghost" style="color:var(--color-accent-800)" @click="clearAll">{{ t('settings.clearAll') }}</button>
      </div>
    </div>

    <!-- 关于 -->
    <div v-show="activeTab === 'about'" class="card">
      <div style="font-family:var(--font-heading);font-size:22px">{{ t('settings.aboutTitle') }}</div>
      <div style="font-size:13px;color:var(--color-neutral-700);line-height:1.9;margin-top:6px">
        {{ t('settings.version', { ver: version }) }} <button type="button" class="btn btn-ghost" @click="checkUpdate">{{ t('settings.checkUpdate') }}</button><br />
        {{ t('settings.techStack') }}<br />
        {{ t('settings.aboutDesc') }}<br />{{ t('settings.copyright') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAppStore } from '../../stores/app';
import type { AppSettings } from '../../../../shared/types';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import { setLocale, SUPPORTED_LOCALES } from '../../i18n';
const { t } = useI18n();

// 加密实际状态（区别于"开关想不想加密"）
const enc = ref<{ mode: 'off' | 'on' | 'degraded'; reason: string; available: boolean }>({
  mode: 'off', reason: '', available: false,
});
const encFixing = ref(false);
async function loadEnc() {
  try { enc.value = await window.api.getEncryptionStatus(); } catch { /* 主进程未就绪则保持默认 */ }
}
async function fixEncryption() {
  encFixing.value = true;
  try {
    const r = await window.api.resetEncryptionKey();
    if (r.ok) {
      ElMessage.success(t('settings.msgEncResetDone'));
    } else {
      ElMessage.error(r.reason || t('settings.msgEncResetFailed'));
    }
    await loadEnc();
  } catch (e: any) {
    ElMessage.error(e?.message || t('settings.msgEncResetFailed'));
  } finally {
    encFixing.value = false;
  }
}

const store = useAppStore();
const activeTab = ref('general');
const version = ref('1.0.0');
const form = ref<AppSettings>(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
const dirty = ref(false);
const suppressWatch = ref(false);
const showBrowserAdv = ref(false); // 浏览器高级设置默认折叠
const cdpConnected = computed(() => store.cdpConnected);
const browserOpen = computed(() => store.browserOpen);

// 猎聘浏览器状态：设置页同时摆着【两个】浏览器的按钮，而 store 里的 browserOpen 只跟随
// 当前激活平台——在 BOSS tab 下看设置页，猎聘那盏灯就永远是灭的。故这里独立取一次猎聘状态。
const liepinOpen = ref(false);
let liepinTimer: any = null;
async function refreshLiepinStatus() {
  try { liepinOpen.value = !!(await window.api.getCdpStatus('liepin'))?.open; } catch { /* 取不到就保持原值 */ }
}

// 7→4：RPA / 风险 / 匹配评分 tab 前端隐藏（参数后端 DEFAULT_SETTINGS 定死），只留通用/浏览器/数据管理/关于。
const tabs = [
  { k: 'general', label: t('settings.tabGeneral') },
  { k: 'browser', label: t('settings.tabBrowser') },
  { k: 'data', label: t('settings.tabData') },
  { k: 'about', label: t('settings.tabAbout') },
];

async function checkUpdate() { const r = await window.api.checkUpdate(); ElMessage.info(r?.message || t('settings.msgUpdateLatest')); }

async function load() {
  suppressWatch.value = true;
  let s: any;
  try { s = await window.api.getSettings(); } catch { suppressWatch.value = false; return; }
  form.value = JSON.parse(JSON.stringify(s));
  dirty.value = false;
  await nextTick();
  suppressWatch.value = false;
}
async function save() {
  // P1-17：较低匹配阈值必须严格小于高度阈值，且都落在合理区间（0-100）。
  // tab 虽隐藏但后端契约仍校验，此处保留前置校验，防脏值落库。
  const hi = Number(form.value.matchScore?.highThreshold);
  const lo = Number(form.value.matchScore?.lowThreshold);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || lo >= hi || lo < 0 || hi > 100) {
    ElMessage.error(t('settings.msgThresholdInvalid'));
    return;
  }
  await window.api.saveSettings(form.value);
  // 语言切换：保存即生效，同步 vue-i18n 与 Element Plus locale
  setLocale(form.value.general.language);
  ElMessage.success(t('settings.msgSaved'));
  dirty.value = false;
  await store.init();
}

async function launchBrowser() {
  try {
    if (dirty.value) { await window.api.saveSettings(form.value); setLocale(form.value.general.language); dirty.value = false; await store.init(); }
    // 只打开 BOSS 浏览器供登录（不连 puppeteer，避免被 BOSS 检测）；连接在「开始找人」时才发生
    const r = await window.api.openBrowserForLogin();
    if (r.launched) ElMessage.success(t('settings.msgBossLaunched'));
    else if (r.focused) ElMessage.success(t('settings.msgBossFocused'));
    else ElMessage.warning(t('settings.msgBossNotFocused'));
  } catch (e: any) { ElMessage.error(e.message || t('settings.msgOpenFailed')); }
}
async function launchLiepinBrowser() {
  try {
    if (dirty.value) { await window.api.saveSettings(form.value); setLocale(form.value.general.language); dirty.value = false; await store.init(); }
    // 猎聘浏览器：独立端口 9333、独立 profile。走与 BOSS 同一个通道，只是平台参数不同。
    const r = await window.api.openBrowserForLogin('liepin');
    await refreshLiepinStatus();   // 立刻点亮状态灯，不等轮询
    if (r.alreadyOpen && !r.launched) ElMessage.success(t('settings.msgLiepinAlreadyOpen'));
    else ElMessage.success(t('settings.msgLiepinLaunched'));
  } catch (e: any) {
    ElMessage.error(e?.message || t('settings.msgLiepinOpenFailed'));
  }
}
async function exportCsv() { await window.api.exportCsv({ platform: store.activePlatform }); }
async function clearAll() {
  // 如实列明影响范围：这一键横跨全部四条线（RPA / 插件 / 两个飞书工具），不能只写"所有数据"
  try {
    await ElMessageBox.confirm(t('settings.msgClearAllConfirm'), t('common.confirm'), { type: 'error' });
    const ok = await window.api.clearAllData();
    if (ok) { ElMessage.success(t('settings.msgCleared')); load(); }
  } catch { /* cancelled */ }
}
function openDataFolder() { window.api.openDataFolder(); }
async function backupData() {
  try {
    const r = await window.api.backupData();
    if (r?.ok) ElMessage.success(t('settings.msgBackupDone', { path: r.path }));
    else if (r?.error) ElMessage.error(t('settings.msgBackupFailed', { reason: r.error }));
  } catch (e: any) { ElMessage.error(e.message || t('settings.msgBackupFailed', { reason: e?.message || '' })); }
}
async function restoreData() { try { await window.api.restoreData(); } catch (e: any) { ElMessage.error(e.message || t('settings.msgRestoreFailed')); } }
async function importCandidates() {
  try {
    const r: any = await (window.api as any).importData();
    if (r?.canceled) return;
    if (r?.ok) { ElMessage.success(t('settings.msgImportDone', { imported: r.imported ?? 0, skipped: r.skipped ?? 0 })); load(); }
    else ElMessage.error(t('settings.msgImportFailed', { reason: r?.error || '' }));
  } catch (e: any) { ElMessage.error(e.message || t('settings.msgImportFailed', { reason: e?.message || '' })); }
}

watch(form, () => { if (suppressWatch.value) return; dirty.value = true; }, { deep: true });
onMounted(async () => {
  try { version.value = await window.api.getVersion(); } catch { /* 取不到版本保持默认 */ }
  await load(); await loadEnc();
  await refreshLiepinStatus();
  // 用户可能直接在浏览器里关窗口，事件覆盖不到，定期校准（与 store 的安全网同一思路）
  liepinTimer = setInterval(refreshLiepinStatus, 6000);
});
onUnmounted(() => { if (liepinTimer) clearInterval(liepinTimer); });
</script>
