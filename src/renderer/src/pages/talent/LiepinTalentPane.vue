<template>
  <div class="lp-pane">
    <!-- 顶部统计：今日剩余额度必须显眼（打开简历扣套餐额度，TA 最关心"还能点几份"） -->
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <span class="tag tag-accent-2">{{ t('talent.lpInPool', { n: stats.total }) }}</span>
      <span class="tag">{{ t('talent.lpTodayNew', { n: stats.today }) }}</span>
      <span class="tag" :class="quotaRemain <= 2 ? 'tag-accent' : 'tag-neutral'">
        {{ t('talent.lpQuota', { used: stats.todayOpened || 0, limit: stats.dailyLimit || '—' }) }}
        <template v-if="stats.dailyLimit > 0">{{ t('talent.lpQuotaRemain', { n: Math.max(0, stats.dailyLimit - (stats.todayOpened || 0)) }) }}</template>
      </span>
      <button v-if="stats.expiring" type="button" class="btn btn-ghost"
        style="font-size:12px;color:var(--color-accent-700)" @click="showExpiring = !showExpiring">
        {{ t('talent.lpExpiringBtn', { n: stats.expiring }) }}
      </button>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-secondary" @click="reload">{{ t('talent.refresh') }}</button>
    </div>

    <!-- 待清理区（折叠） -->
    <div v-if="showExpiring" class="card" style="margin-bottom:14px;border-left:3px solid var(--color-accent)">
      <div class="card-kicker" style="margin-bottom:8px">{{ t('talent.lpExpiringTitle') }}</div>
      <div v-if="!expiring.length" class="empty">{{ t('talent.lpNoExpiring') }}</div>
      <div v-else style="display:grid;gap:6px;max-height:220px;overflow:auto">
        <label v-for="e in expiring" :key="e.res_id" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" :value="e.res_id" v-model="expiringPicked" />
          <span style="flex:1">{{ t('talent.lpExpiringRow', { name: e.name || t('talent.lpNoName'), company: e.company || '—', date: e.keep_until }) }}</span>
        </label>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button type="button" class="btn btn-secondary" :disabled="!expiringPicked.length"
          @click="doArchive(expiringPicked, true)">{{ t('talent.lpArchiveBtn') }}</button>
        <button type="button" class="btn btn-ghost" style="color:var(--color-accent-700)"
          :disabled="!expiringPicked.length" @click="doDelete(expiringPicked)">{{ t('talent.lpDeleteBtn') }}</button>
      </div>
    </div>

    <!-- ★ 两列布局：左固定宽、右自适应，各自独立滚动，杜绝旧版卡片重叠。
         旧版根因：外层无定高容器 + .card 是 flex-column 又内嵌 max-height 滚动区，
         岗位一多左列撑过视口，右列 max-height:calc(100vh-300px) 与左列高度失配，
         两列内容互相压叠。改为两列各自定高 + overflow:auto，列间用 border 分隔。 -->
    <div class="lp-two-col">
      <!-- 左列：岗位 -->
      <aside class="lp-left">
        <div class="lp-left-head">
          <div class="card-kicker">{{ t('talent.lpByJob') }}</div>
          <!-- 直接搜岗位名，岗位一多不再靠下滑翻找 -->
          <input class="input" v-model="jdSearch" :placeholder="t('talent.lpSearchJobPh')" />
        </div>
        <div class="lp-left-list">
          <!-- 「全部（取最高分）」恒置顶，不参与搜索过滤与排序 -->
          <button type="button" class="job-item" :class="{ active: !jdId }" @click="pickJd('')">
            <span class="job-item-name">{{ t('talent.lpAllJobsScore') }}</span>
          </button>
          <button v-for="j in sortedJds" :key="j.id" type="button" class="job-item"
            :class="{ active: jdId === j.id }" @click="pickJd(j.id)">
            <span class="job-item-name">{{ j.name }}</span>
            <!-- 常用靠前：把候选人数量亮出来，让 TA 一眼知道哪个岗位积累得多 -->
            <span v-if="jdCount(j.id) > 0" class="job-item-count">{{ jdCount(j.id) }}</span>
          </button>
          <div v-if="!sortedJds.length" class="empty" style="padding:16px">{{ t('talent.noData') }}</div>
        </div>
      </aside>

      <!-- 右列：候选人 -->
      <section class="lp-right">
        <div class="lp-right-head">
          <span class="card-kicker">{{ t('talent.lpJobCount', { name: jdName, n: filteredRows.length }) }}</span>
          <!-- 匹配度筛选：改读评分引擎写在 reasons.cardVerdictLabel 的三档判定（值得看/一般/不匹配），
               不再用 ≥80/≥70/≥60 的分数档——卡片层分数无区分度，三档才是引擎真正想表达的结论。
               走前端过滤（只筛已加载卡片），后端 listLiepinTalents 与低于60不显示的口径保持不变。 -->
          <select class="input" v-model="verdictFilter" style="width:auto">
            <option value="">{{ t('talent.lpMatchAll') }}</option>
            <option value="值得看">{{ t('talent.lpMatchWorth') }}</option>
            <option value="一般">{{ t('talent.lpMatchFair') }}</option>
            <option value="不匹配">{{ t('talent.lpMatchNoMatch') }}</option>
          </select>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" v-model="archived" @change="reload" />{{ t('talent.lpShowArchived') }}
          </label>
          <input class="input" v-model="q" :placeholder="t('talent.searchPlaceholder')" style="width:180px" @keyup.enter="reload" />
        </div>

        <div class="lp-right-list">
          <div v-if="loading" class="empty">{{ t('talent.lpLoading') }}</div>
          <div v-else-if="!filteredRows.length" class="empty">{{ t('talent.lpNoRows') }}</div>
          <div v-else class="cand-list-inner">
            <div v-for="r in filteredRows" :key="r.res_id" class="cand">
              <span class="cand-dot" :style="{ background: scoreColor(r.score) }"></span>
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <strong style="font-size:14px">{{ r.name || t('talent.lpNoName') }}</strong>
                  <span style="font-size:12.5px;color:var(--color-neutral-700)">{{ r.position || '—' }}</span>
                  <span style="font-size:12.5px;color:var(--color-neutral-600)">{{ r.company || '—' }}</span>
                  <!-- 卡片层（depth=A）显示三档判定，不显示数字分；depth=B（已看过简历）才有完整履历，数字分才有意义。 -->
                  <span class="tag" :style="{ background: r.insufficient_evidence ? 'var(--color-neutral-200)' : scoreBg(r.score) }">
                    {{ cardVerdictOf(r) || t('talent.lpScore', { n: Math.round(r.score || 0) }) }}
                  </span>
                  <span v-if="r.insufficient_evidence" class="tag tag-neutral" style="font-size:11px;opacity:.8" :title="t('talent.lpInsufficientTitle')">{{ t('talent.lpInsufficient') }}</span>
                  <span v-if="r.depth === 'B'" class="tag" style="font-size:11px">{{ t('talent.lpSeenResume') }}</span>
                  <span v-if="r.active_status" class="tag" style="font-size:11px">{{ r.active_status }}</span>
                </div>
                <div style="font-size:12px;color:var(--color-neutral-600);margin-top:3px">
                  {{ [r.city, r.experience, r.degree].filter(Boolean).join(' · ') || '—' }}
                  <span style="margin-left:8px">{{ t('talent.lpFirstSeen', { date: r.first_seen }) }}</span>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
                <!-- ★ 打开简历 = 真实扣一份套餐额度，openDetail 内有确认弹窗（显示剩余额度），不新增自动点击 -->
                <button type="button" class="btn btn-primary" style="font-size:12px;padding:5px 12px"
                  @click="openDetail(r)">{{ t('talent.lpOpenResume') }}</button>
                <button type="button" class="btn btn-ghost" style="font-size:11.5px;padding:2px 8px"
                  @click="showScores(r)">{{ t('talent.lpAllScores') }}</button>
                <button type="button" class="btn btn-ghost" style="font-size:11.5px;padding:2px 8px"
                  @click="doArchive([r.res_id], !archived)">{{ archived ? t('talent.lpArchiveAction') : t('talent.lpArchiveActionOn') }}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const props = defineProps<{ jds: Array<{ id: string; name: string }> }>();

const rows = ref<any[]>([]);
const stats = ref<any>({ total: 0, today: 0, archived: 0, expiring: 0, todayOpened: 0, dailyLimit: 0 });
const expiring = ref<any[]>([]);
const expiringPicked = ref<string[]>([]);
const showExpiring = ref(false);
const loading = ref(false);
const jdId = ref('');
const q = ref('');
const archived = ref(false);
const keepDays = 180;

// 左列：岗位搜索框（直接搜岗位名，不再靠下滑）
const jdSearch = ref('');

// 每个岗位的候选人数量 —— 从「全部（取最高分）」视图加载的行里聚合而来。
// 后端 listLiepinTalents 在不指定 jdId 时做 LEFT JOIN 取每人最高分，行里带 jd_id，
// 这里按 jd_id 计数即得「该岗位有多少人」。无需新增后端 IPC，口径与数据源完全一致。
const jdCounts = ref<Record<string, number>>({});
function jdCount(id: string): number { return jdCounts.value[id] || 0; }

const jds = computed(() => props.jds || []);
const jdName = computed(() => jds.value.find((j) => j.id === jdId.value)?.name || t('talent.lpAllJobsName'));

// 常用岗位靠前：按候选人数量倒序；数量并列时维持岗位库原序（稳定排序）。
// 「全部（取最高分）」恒置顶（在模板里单独渲染，不进这个列表）。
// 搜索框先按名称过滤，再排序。
const sortedJds = computed(() => {
  const kw = jdSearch.value.trim().toLowerCase();
  const list = kw
    ? jds.value.filter((j) => j.name.toLowerCase().includes(kw))
    : jds.value.slice();
  return list.sort((a, b) => jdCount(b.id) - jdCount(a.id));
});

// 今日剩余额度，供确认弹窗与顶部徽章复用
const quotaRemain = computed(() => {
  const lim = stats.value.dailyLimit;
  if (!lim || lim <= 0) return Infinity;
  return Math.max(0, lim - (stats.value.todayOpened || 0));
});

/**
 * 判定文案；depth=B（已看过简历）且非"信息不足"时返回 null，由调用方回落到数字分。
 * 卡片层（depth=A）一律显示四档判定；verdict 由评分引擎写在 liepin_talent_scores.reasons 里。
 * 阶段8：判定文案属动态数据，不译——与动态内容不译口径一致。
 */
function cardVerdictOf(r: any): string | null {
  let label: string | null = null;
  try {
    const j = typeof r?.reasons === 'string' ? JSON.parse(r.reasons) : r?.reasons;
    label = j?.cardVerdictLabel || null;
  } catch { return null; }
  // detail 层只有"信息不足"才显示判定文案，其余情况让数字分说话
  if (r?.depth === 'B' && label !== '信息不足') return null;
  return label;
}

// 匹配度三档筛选：按引擎写入的 cardVerdictLabel 前端过滤已加载卡片。
// 空串 = 全部。卡在 verdictFilter 不在 reload，故不触发后端重查——后端口径零变更。
const verdictFilter = ref('');
const filteredRows = computed(() => {
  const vf = verdictFilter.value;
  if (!vf) return rows.value;
  return rows.value.filter((r) => cardVerdictOf(r) === vf);
});

function scoreColor(s: number) {
  if (s >= 80) return 'var(--color-accent)';
  if (s >= 70) return 'var(--color-accent-2, #6aa84f)';
  return 'var(--color-neutral-400)';
}
function scoreBg(s: number) {
  return s >= 80 ? 'rgba(220,120,60,.16)' : s >= 70 ? 'rgba(120,170,90,.16)' : 'var(--color-neutral-200)';
}

async function reload() {
  loading.value = true;
  try {
    const r = await (window as any).api.liepinTalents({
      jdId: jdId.value || undefined,
      q: q.value || undefined,
      archived: archived.value,
      // 与旧版「全部匹配度」一致：传 minScore=0 → 后端 if(minScore>0) 不裁分，取全量。
      // 后端 listLiepinTalents 及「低于60不显示」口径零变更（默认 60 仍由缺省调用方保持）。
      minScore: 0,
    });
    rows.value = r?.rows || [];
    stats.value = await (window as any).api.liepinTalentStats();
    if (stats.value.expiring) expiring.value = await (window as any).api.liepinTalentExpiring();
    // 「全部（取最高分）」视图聚合每岗位人数用于排序；选定具体岗位时不重算（那只是该岗位自己）。
    if (!jdId.value) {
      const counts: Record<string, number> = {};
      for (const row of rows.value) {
        const jid = row?.jd_id;
        if (jid) counts[jid] = (counts[jid] || 0) + 1;
      }
      jdCounts.value = counts;
    }
  } catch (e: any) {
    ElMessage.error(t('talent.lpLoadFail', { reason: e?.message || e }));
  } finally {
    loading.value = false;
  }
}

function pickJd(id: string) { jdId.value = id; verdictFilter.value = ''; reload(); }

async function doArchive(ids: string[], toArchived: boolean) {
  await (window as any).api.liepinTalentArchive(ids, toArchived);
  expiringPicked.value = [];
  ElMessage.success(toArchived ? t('talent.lpArchivedDone') : t('talent.lpUnarchivedDone'));
  reload();
}

async function doDelete(ids: string[]) {
  try {
    await ElMessageBox.confirm(
      t('talent.lpConfirmDeleteMsg', { n: ids.length }),
      t('talent.lpConfirmDeleteTitle'), { type: 'warning', confirmButtonText: t('talent.lpConfirmDeleteBtn'), cancelButtonText: t('common.cancel') },
    );
  } catch { return; }
  await (window as any).api.liepinTalentDelete(ids);
  expiringPicked.value = [];
  ElMessage.success(t('talent.lpDeletedDone'));
  reload();
}

/** ★ 打开简历 = 真实扣一份套餐额度，必须先明示再执行（确认弹窗保留，不新增自动点击） */
async function openDetail(r: any) {
  const seen = r.detail_at ? t('talent.lpOpenSeen') : '';
  // 确认弹窗必须显示今日剩余额度，让 TA 点之前心里有数
  const remainTxt = stats.value.dailyLimit > 0
    ? '\n\n' + t('talent.lpQuotaUsed', { used: stats.value.todayOpened || 0, limit: stats.value.dailyLimit, remain: quotaRemain.value })
    : '';
  try {
    await ElMessageBox.confirm(
      t('talent.lpOpenConfirmMsg', { name: r.name || t('talent.lpNoName'), seen, quota: remainTxt }),
      t('talent.lpOpenConfirmTitle'), { type: 'warning', confirmButtonText: t('talent.lpOpenConfirmBtn'), cancelButtonText: t('common.cancel'),
        customStyle: { whiteSpace: 'pre-wrap' } },
    );
  } catch { return; }
  // IPC 抛异常时必须明确"没扣额度"——TA 最担心的是"扣了没打开"
  let res: any;
  try {
    res = await (window as any).api.liepinTalentOpen(r.res_id);
  } catch (e: any) {
    ElMessage.error(t('talent.lpOpenFailMsg', { reason: e?.message || '' }));
    return;
  }
  if (res?.ok) {
    const remain = res.dailyLimit > 0 ? Math.max(0, (res.dailyLimit || 0) - (res.todayUsed || 0)) : '';
    ElMessage.success(t('talent.lpOpenOkMsg', { remain: remain !== '' ? t('talent.lpOpenOkRemain', { n: remain }) : '' }));
    reload();
  } else {
    ElMessage.error({ message: t('talent.lpOpenFail2', { reason: res?.reason || '' }), duration: 6000 });
  }
}

async function showScores(r: any) {
  const list = await (window as any).api.liepinTalentScores(r.res_id);
  const nameOf = (id: string) => jds.value.find((j) => j.id === id)?.name || id;
  const body = (list || []).length
    ? list.map((s: any) => t('talent.lpScoresLine', { name: nameOf(s.jd_id), score: Math.round(s.score), level: s.level })).join('\n')
    : t('talent.lpNoScores');
  ElMessageBox.alert(body, t('talent.lpScoresTitle', { name: r.name || t('talent.lpNoName') }), { confirmButtonText: t('talent.lpScoresOk') });
}

onMounted(reload);
defineExpose({ reload });
</script>

<style scoped>
/* ★ 修重叠根因：外层定高 + 两列各自独立滚动。
   旧版外层 <div> 无定高，内嵌 .card(flex-column) 又套 max-height 滚动区，
   岗位一多左列撑过视口，与右列内容互相压叠。现在外层给明确高度，列内各自 overflow。 */
.lp-pane { display: flex; flex-direction: column; min-height: 0; }
.lp-two-col {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr); /* 右列 minmax(0,1fr) 防止内容撑爆网格 */
  gap: 18px;
  align-items: stretch;
}
.lp-left {
  display: flex; flex-direction: column;
  min-height: 0;
  max-height: calc(100vh - 220px);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  overflow: hidden; /* 头部固定，仅列表区滚动 */
}
.lp-left-head {
  padding: 12px 14px;
  display: grid; gap: 8px;
  border-bottom: 1px solid var(--color-divider);
  position: sticky; top: 0; background: var(--color-surface);
}
.lp-left-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; padding: 8px; }
.lp-right {
  display: flex; flex-direction: column;
  min-height: 0; max-width: 100%;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  overflow: hidden;
}
.lp-right-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-divider);
  position: sticky; top: 0; background: var(--color-surface);
}
.lp-right-list {
  flex: 1; min-height: 0; overflow-y: auto;
  max-height: calc(100vh - 220px);
}
.cand-list-inner { display: grid; gap: 8px; padding: 12px 14px; }
.job-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer;
  border: none; border-radius: var(--radius-md); background: transparent;
  color: var(--color-text); font: inherit; transition: background .15s; text-align: left;
}
.job-item:hover { background: var(--color-neutral-200); }
.job-item.active { background: var(--color-accent); color: var(--color-bg); }
.job-item-name { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-item-count {
  flex: none; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: var(--color-neutral-200); color: var(--color-neutral-800);
  display: grid; place-items: center; font-size: 11px; font-weight: 700;
}
.job-item.active .job-item-count { background: var(--color-bg); color: var(--color-accent); }
.cand {
  display: flex; align-items: center; gap: 12px; padding: 11px 14px;
  border-radius: var(--radius-md); background: var(--color-neutral-100);
}
.cand-dot { width: 9px; height: 9px; flex: none; border-radius: 999px; }
</style>
