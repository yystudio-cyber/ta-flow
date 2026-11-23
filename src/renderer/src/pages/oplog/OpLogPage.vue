<template>
  <div class="page-wrap" style="max-width:1180px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <h1 class="page-h1" style="flex:1">{{ t('oplog.title') }}</h1>
      <button type="button" class="btn btn-secondary" @click="reload">{{ t('oplog.refresh') }}</button>
    </div>

    <!-- D8(2026-08-05)：日志健康状态条 —— TA 独立跑的前提是"知道日志确实在记"，
         出问题时我能不能从日志看出来，全看这条信号是不是绿的。 -->
    <div class="card" style="margin-bottom:16px;padding:14px 18px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span v-if="health.enabled" class="tag tag-accent-2" style="font-size:13px;padding:6px 12px">
          {{ t('oplog.recording') }}
        </span>
        <span v-else class="tag tag-accent" style="font-size:13px;padding:6px 12px">
          {{ t('oplog.notRecording') }}
        </span>
        <div style="flex:1;min-width:0;font-size:13px;color:var(--color-neutral-700);line-height:1.7">
          <template v-if="health.enabled">
            {{ t('oplog.todaySize', { size: kbSize(health.todayBytes), min: lastWriteMinAgo }) }}
            <span style="color:var(--color-neutral-600)">{{ t('oplog.recordingDesc') }}</span>
          </template>
          <template v-else>
            {{ health.disabledReason || t('oplog.disabledFallback') }}
            <span style="color:var(--color-accent-700)">{{ t('oplog.notRecordingDesc', { reason: '' }) }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- D8(2026-08-05)：导出诊断包按钮做显眼 + 明确告诉 TA 导出后怎么给我 -->
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:18px;flex-wrap:wrap">
      <button type="button" class="btn btn-primary" style="font-size:14px;padding:10px 20px" @click="doExport">
        {{ t('oplog.exportBundle') }}
      </button>
      <button type="button" class="btn btn-secondary" @click="openDir">{{ t('oplog.openDir') }}</button>
      <div style="flex:1;min-width:240px;font-size:12.5px;color:var(--color-neutral-600);line-height:1.7;padding-top:6px">
        {{ t('oplog.exportHint') }}
        <span style="color:var(--color-neutral-500)">{{ t('oplog.exportHint2') }}</span>
      </div>
      <span v-if="exported" style="font-size:12px;color:var(--color-accent-2);align-self:center">{{ t('oplog.exported', { file: exported }) }}</span>
    </div>

    <!-- D5(2026-08-05)：明细/汇总给开发看，默认折叠；上面留一句结论给 TA -->
    <details class="card dev-fold" style="padding:14px 18px">
      <summary style="cursor:pointer;font-size:13px;color:var(--color-neutral-600);user-select:none;list-style:none">
        <span style="display:inline-flex;align-items:center;gap:8px">
          <span style="font-size:11px;padding:2px 8px;border-radius:999px;background:var(--color-neutral-200);color:var(--color-neutral-700)">{{ t('oplog.devFold') }}</span>
          {{ t('oplog.devFoldSummary') }}
        </span>
      </summary>
      <div style="margin-top:14px">
        <div class="seg" style="margin-bottom:14px">
          <label class="seg-opt"><input type="radio" value="summary" v-model="tab" />{{ t('oplog.summaryTab') }}</label>
          <label class="seg-opt"><input type="radio" value="recent" v-model="tab" />{{ t('oplog.recentTab') }}</label>
        </div>

        <!-- 汇总：按功能域聚合，失败最多的排最前 -->
        <div v-if="tab === 'summary'">
          <div class="card-kicker" style="margin-bottom:10px">{{ t('oplog.summary3Days') }}</div>
          <div v-if="!summary.length" class="empty">{{ t('oplog.noLogYet') }}</div>
          <table v-else style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--color-neutral-200)">
                <th style="padding:6px 4px">{{ t('oplog.thArea') }}</th><th style="padding:6px 4px">{{ t('oplog.thAction') }}</th>
                <th style="padding:6px 4px;text-align:right">{{ t('oplog.thCalls') }}</th>
                <th style="padding:6px 4px;text-align:right">{{ t('oplog.thFail') }}</th>
                <th style="padding:6px 4px;text-align:right">{{ t('oplog.thP95') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in summary" :key="i"
                :style="{ borderBottom: '1px solid var(--color-neutral-100)', background: s.fail > 0 ? 'var(--color-accent-100)' : '' }">
                <td style="padding:5px 4px"><span class="tag" style="font-size:11px">{{ s.area }}</span></td>
                <td style="padding:5px 4px;font-family:monospace;font-size:12px">{{ s.action }}</td>
                <td style="padding:5px 4px;text-align:right">{{ s.n }}</td>
                <td style="padding:5px 4px;text-align:right;font-weight:600"
                  :style="{ color: s.fail > 0 ? 'var(--color-accent-700)' : 'inherit' }">{{ s.fail || '' }}</td>
                <td style="padding:5px 4px;text-align:right">{{ s.p95 ? s.p95 + ' ms' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 明细：最近若干条，倒序 -->
        <div v-else>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span class="card-kicker" style="flex:1">{{ t('oplog.recentN', { n: entries.length }) }}</span>
            <label style="font-size:12px;display:flex;align-items:center;gap:4px">
              <input type="checkbox" v-model="onlyFail" />{{ t('oplog.onlyFail') }}
            </label>
          </div>
          <div v-if="!shown.length" class="empty">{{ t('oplog.noRecords') }}</div>
          <div v-else style="max-height:500px;overflow:auto;font-family:monospace;font-size:12px">
            <div v-for="(e, i) in shown" :key="i"
              style="padding:4px 6px;border-bottom:1px solid var(--color-neutral-100);display:flex;gap:8px"
              :style="{ background: e.ok === false ? 'var(--color-accent-100)' : '' }">
              <span style="opacity:.55;white-space:nowrap">{{ fmtTime(e.t) }}</span>
              <span class="tag" style="font-size:10px">{{ e.a }}</span>
              <span style="flex:1;min-width:0;word-break:break-all">
                {{ e.n }}
                <span v-if="e.p" style="opacity:.55">[{{ e.p }}]</span>
                <span v-if="e.d" style="opacity:.7">{{ brief(e.d) }}</span>
              </span>
              <span v-if="e.ms != null" style="opacity:.55;white-space:nowrap">{{ e.ms }}ms</span>
              <span v-if="e.ok === false" style="color:var(--color-accent-700);white-space:nowrap">{{ t('oplog.failed') }}</span>
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const tab = ref<'summary' | 'recent'>('summary');
const summary = ref<any[]>([]);
const entries = ref<any[]>([]);
const onlyFail = ref(false);
const exported = ref('');

// D8(2026-08-05)：oplog 健康状态 + 自动刷新
const health = ref<{ enabled: boolean; dir: string; todayBytes: number; lastWriteAt: number; disabledReason?: string }>({
  enabled: false, dir: '', todayBytes: 0, lastWriteAt: 0,
});
let healthTimer: any = null;

function kbSize(b: number): string {
  if (!b) return '0 KB';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
const lastWriteMinAgo = computed(() => {
  if (!health.value.lastWriteAt) return t('oplog.lastWriteNever');
  return Math.max(0, Math.round((Date.now() - health.value.lastWriteAt) / 60000));
});

async function loadHealth() {
  try {
    health.value = await (window as any).api.oplogHealth();
  } catch {
    health.value = { enabled: false, dir: '', todayBytes: 0, lastWriteAt: 0, disabledReason: t('oplog.healthReadFailed') };
  }
}

const shown = computed(() => (onlyFail.value ? entries.value.filter((e) => e.ok === false) : entries.value));

function fmtTime(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function brief(d: any) {
  try {
    const s = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(' ');
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch { return ''; }
}

async function reload() {
  try {
    summary.value = await (window as any).api.oplogSummary(3);
    entries.value = await (window as any).api.oplogRecent(400);
  } catch (e: any) {
    ElMessage.error(t('oplog.msgReadFailed', { reason: e?.message || e }));
  }
  await loadHealth();
}
async function doExport() {
  const r = await (window as any).api.oplogExport(7);
  if (r?.ok) {
    exported.value = r.file || '';
    ElMessage.success({
      message: t('oplog.msgExportDone'),
      duration: 8000,
    });
  } else {
    ElMessage.error(r?.reason || t('oplog.msgExportFailed'));
  }
}
async function openDir() { await (window as any).api.oplogOpenDir(); }

onMounted(() => {
  reload();
  // D8：每 30s 自动刷新健康状态，TA 能看到"最近写入 X 分钟前"在更新
  healthTimer = setInterval(loadHealth, 30000);
});
onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer);
});
</script>

<style scoped>
/* D5(2026-08-05)：默认收起的开发细节区样式 */
.dev-fold summary::-webkit-details-marker { display: none; }
.dev-fold[open] summary { margin-bottom: 6px; }
</style>
