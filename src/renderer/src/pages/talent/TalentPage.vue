<template>
  <div class="page-wrap" style="max-width:1180px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <h1 class="page-h1" style="flex:1">{{ t('talent.title') }}</h1>
      <!-- 两块并列：BOSS 是"最近一轮结果"，猎聘是"长久保存的人才池"，语义不同故分开 -->
      <div class="seg">
        <label class="seg-opt"><input type="radio" value="boss" v-model="pane" />BOSS</label>
        <label class="seg-opt"><input type="radio" value="liepin" v-model="pane" />{{ t('common.liepin') }}</label>
      </div>
    </div>

    <LiepinTalentPane v-if="pane === 'liepin'" :jds="jdOptions" />

    <template v-else>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <div class="seg" style="flex:1">
        <label class="seg-opt"><input type="radio" value="all" v-model="viewFilter" />{{ t('talent.filterAll') }}</label>
        <label class="seg-opt"><input type="radio" value="unviewed" v-model="viewFilter" />{{ t('talent.filterUnviewed') }}</label>
        <label class="seg-opt"><input type="radio" value="viewed" v-model="viewFilter" />{{ t('talent.filterViewed') }}</label>
      </div>
      <button type="button" class="btn btn-secondary" @click="refresh">{{ t('talent.refresh') }}</button>
    </div>
    <p style="margin:0 0 22px;font-size:13.5px;color:var(--color-neutral-700)">
      <span v-html="t('talent.bossHint')"></span>
      <span style="color:var(--color-neutral-600)">{{ t('talent.bossHint2') }}</span>
    </p>

    <!-- 加载错误横幅（IPC 异常时留在列表上方，重试按钮可重新加载） -->
    <div v-if="loadError" style="margin-bottom:14px;padding:12px 16px;border-radius:var(--radius-lg);background:var(--color-accent-100);font-size:13px;color:var(--color-accent-800)">
      {{ t('talent.loadFailed', { reason: loadError }) }}<button type="button" class="btn btn-ghost" style="font-size:12px;padding:2px 8px" @click="refresh">{{ t('common.retry') }}</button>
    </div>

    <div style="display:grid;grid-template-columns:270px 1fr;gap:18px;align-items:start">
      <!-- 左：岗位列表 -->
      <div style="display:grid;gap:8px">
        <button
          v-for="j in jobBuckets" :key="j.key" type="button" class="job-item" :class="{ active: selectedKey === j.key }"
          @click="selectJob(j.key)"
        >
          <span style="flex:1;min-width:0;text-align:left">
            <span style="display:block;font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ j.name }}</span>
            <span style="display:block;font-size:11.5px;opacity:0.6;margin-top:2px">{{ t('talent.totalPeople', { n: j.total }) }}</span>
          </span>
          <span v-if="j.unviewed > 0" class="unread-badge">{{ j.unviewed }}</span>
        </button>
        <div v-if="!jobBuckets.length" class="empty" style="padding:24px">{{ t('talent.noData') }}</div>
      </div>

      <!-- 右：候选人列表 -->
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="card-kicker" style="flex:1">{{ t('talent.currentJob', { name: currentJobName, n: filtered.length }) }}</span>
          <input class="input" v-model="keyword" :placeholder="t('talent.searchPlaceholder')" style="width:220px" />
        </div>
        <div v-if="!filtered.length" class="empty">{{ t('talent.noMatch') }}</div>
        <div v-else style="display:grid;gap:8px;margin-top:6px;max-height:calc(100vh - 260px);overflow-y:auto;padding-right:4px">
          <div v-for="c in filtered" :key="c.id" class="cand" :class="{ seen: c.viewed }">
            <span class="cand-dot" :style="{ background: c.viewed ? 'var(--color-neutral-400)' : 'var(--color-accent)' }"></span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <strong style="font-size:14px">{{ c.name || t('talent.noName') }}</strong>
                <span style="font-size:12.5px;color:var(--color-neutral-700)">{{ c.position || '—' }}</span>
                <span class="tag tag-neutral" v-if="c.company">{{ c.company }}</span>
                <span class="tag" :class="c.viewed ? 'tag-neutral' : 'tag-accent'">{{ c.viewed ? t('talent.viewed') : t('talent.unviewed') }}</span>
                <span class="tag tag-accent-2" v-if="c.greeted">{{ t('talent.greeted') }}</span>
                <span class="tag tag-accent-2" v-if="c.favorited">{{ t('talent.favorited') }}</span>
              </div>
              <div style="font-size:12px;color:var(--color-neutral-600);margin-top:3px">
                {{ [c.city, c.experience, c.degree, c.salary, c.date].filter(Boolean).join(' · ') }}
              </div>
            </div>
            <!-- 卡片层（depth 非 B）显示三档判定文案（存在 note 里），不显示数字分——
                 卡片信息量不足以支撑精确分，实测一屏全 85。详情层才回落到数字。 -->
            <div class="score" :class="{ 'score-verdict': c.depth !== 'B' && !!c.note }" :style="{ color: scoreCol(c.score) }">
              {{ c.depth !== 'B' && c.note ? c.note : (c.score != null ? Math.round(c.score) : '—') }}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <button type="button" class="btn btn-primary" style="font-size:12px;padding:5px 12px" :disabled="!c.url" @click="openLink(c)">{{ t('talent.openLink') }}</button>
              <button type="button" class="btn btn-ghost" style="font-size:12px" @click="toggleViewed(c)">{{ c.viewed ? t('talent.markUnread') : t('talent.markRead') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import type { JD, TalentCandidate } from '../../../../shared/types';
import LiepinTalentPane from './LiepinTalentPane.vue';

const { t } = useI18n();
// 两块并列：BOSS 沿用原有"最近一轮结果"语义；猎聘是长久保存的人才池
const pane = ref<'boss' | 'liepin'>('boss');
const jds = ref<JD[]>([]);
const jdOptions = computed(() => jds.value.map((j) => ({ id: j.id, name: j.name })));
const stats = ref<Record<string, { total: number; unviewed: number }>>({});
const candidates = ref<TalentCandidate[]>([]);
const selectedKey = ref<string>(''); // jd.id 或 '__none__'
const viewFilter = ref<'all' | 'unviewed' | 'viewed'>('all');
const keyword = ref('');
const loadError = ref('');

// 岗位桶：有候选人的 JD + 未关联桶（岗位来自岗位库，联动显示）
const jobBuckets = computed(() => {
  const buckets: { key: string; name: string; total: number; unviewed: number }[] = [];
  for (const j of jds.value) {
    const s = stats.value[j.id];
    if (s?.total) buckets.push({ key: j.id, name: j.name, total: s.total, unviewed: s.unviewed });
  }
  const none = stats.value['__none__'];
  if (none?.total) buckets.push({ key: '__none__', name: t('talent.unlinked'), total: none.total, unviewed: none.unviewed });
  return buckets;
});
const currentJobName = computed(() => jobBuckets.value.find((b) => b.key === selectedKey.value)?.name || t('talent.noJobSelected'));

const filtered = computed(() => {
  let list = candidates.value;
  if (viewFilter.value === 'unviewed') list = list.filter((c) => !c.viewed);
  else if (viewFilter.value === 'viewed') list = list.filter((c) => c.viewed);
  const kw = keyword.value.trim().toLowerCase();
  if (kw) {
    list = list.filter((c) =>
      [c.name, c.company, c.position, c.city].some((v) => (v || '').toLowerCase().includes(kw)),
    );
  }
  return list;
});

function scoreCol(score: number | null): string {
  if (score == null) return 'var(--color-neutral-500)';
  if (score >= 75) return 'var(--color-accent-2-600)';
  if (score >= 60) return 'var(--color-accent-500)';
  return 'var(--color-neutral-500)';
}

async function loadCandidates() {
  if (!selectedKey.value) { candidates.value = []; return; }
  try {
    candidates.value = await window.api.listCandidates({
      jdId: selectedKey.value === '__none__' ? null : selectedKey.value,
      platform: 'boss', // H2(阶段1):本面板是 BOSS 人才库，显式传 'boss'，杜绝猎聘候选人混入
    });
  } catch (e: any) {
    loadError.value = e?.message || t('common.mainProcessNotReady');
  }
}
function selectJob(key: string) { selectedKey.value = key; loadCandidates(); }

async function openLink(c: TalentCandidate) {
  if (!c.url) return;
  let ok = false;
  if (c.url.startsWith('boss:geek:')) {
    // BOSS 招聘者候选人无永久 URL → 会话重放：驱动已连接的 BOSS 推荐帧点开该候选人
    const gid = c.url.slice('boss:geek:'.length);
    const r = await window.api.openBossGeek(gid);
    ok = r.ok;
    if (!ok) { ElMessage.warning(r.reason || t('talent.msgOpenFailed')); return; }
    ElMessage.success(t('talent.msgOpenedInBoss'));
  } else {
    ok = await window.api.openExternal(c.url);
    if (!ok) { ElMessage.warning(t('talent.msgInvalidLink')); return; }
  }
  if (!c.viewed) { await window.api.markCandidateViewed(c.id, true); c.viewed = true; refreshStats(); }
}
async function toggleViewed(c: TalentCandidate) {
  await window.api.markCandidateViewed(c.id, !c.viewed);
  c.viewed = !c.viewed;
  refreshStats();
}

async function refreshStats() { stats.value = await window.api.candidateStats('boss'); }
async function refresh() {
  loadError.value = '';
  try {
    const [j] = await Promise.all([window.api.listJds(), refreshStats()]);
    jds.value = j;
    if (!selectedKey.value && jobBuckets.value.length) selectedKey.value = jobBuckets.value[0].key;
    await loadCandidates();
  } catch (e: any) {
    loadError.value = e?.message || t('common.mainProcessNotReady');
  }
}
onMounted(refresh);
</script>

<style scoped>
.job-item {
  display: flex; align-items: center; gap: 10px; padding: 12px 15px; cursor: pointer;
  border: none; border-radius: var(--radius-md); background: var(--color-surface);
  color: var(--color-text); font: inherit; transition: background .15s;
}
.job-item:hover { background: var(--color-neutral-200); }
.job-item.active { background: var(--color-accent); color: var(--color-bg); }
.job-item.active .unread-badge { background: var(--color-bg); color: var(--color-accent); }
.unread-badge {
  flex: none; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  background: var(--color-accent); color: var(--color-bg);
  display: grid; place-items: center; font-size: 11.5px; font-weight: 700;
}
.cand {
  display: flex; align-items: center; gap: 12px; padding: 11px 14px;
  border-radius: var(--radius-md); background: var(--color-neutral-100);
}
.cand.seen { opacity: 0.62; }
.cand-dot { width: 9px; height: 9px; flex: none; border-radius: 999px; }
.score-verdict { font-size: 14px !important; width: 68px !important; font-family: inherit !important; }
.score { flex: none; width: 52px; text-align: center; font-family: var(--font-heading); font-size: 24px; }
</style>
