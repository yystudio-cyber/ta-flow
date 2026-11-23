<template>
  <div class="page-wrap">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <h1 class="page-h1" style="flex:1">{{ t('tools.title') }}</h1>
    </div>
    <p style="margin:0 0 10px;font-size:13.5px;color:var(--color-neutral-700)" v-html="t('tools.topHint')"></p>

    <!-- 工具库收口为【只留浏览器扩展卡 + 导出安装包】（2026-08-20）：
         安装/打开站点/打开目录/教程/行为采样/平台注入工具下半段已全部移除——
         扩展的安装、日常使用走各自教程与 Chrome 扩展页，平台只承担"把安装包带出去"这一件事。
         扩展本身、RPA、飞书桥、评分/db.ts 零碰。 -->
    <!-- D4(2026-08-05)：扩展列表加载失败时显示错误而非让整区凭空消失 -->
    <div v-if="extLoadError" style="margin-bottom:26px;padding:12px 16px;border-radius:var(--radius-lg);background:var(--color-accent-100);font-size:13px;color:var(--color-accent-800)">
      {{ t('tools.extLoadFail', { reason: extLoadError }) }}<button type="button" class="btn btn-ghost" style="font-size:12px;padding:2px 8px" @click="loadExt">{{ t('tools.retry') }}</button>
    </div>
    <div v-if="ext.items.length" style="margin-bottom:26px">
      <div class="divider">{{ t('tools.extSection', { n: ext.items.length }) }}<span style="font-weight:400;color:var(--color-neutral-600)">{{ t('tools.extSectionSub') }}</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-top:14px">
        <div class="card" v-for="e in ext.items" :key="e.dirName">
          <div style="display:flex;align-items:center;gap:12px">
            <div class="tool-ico">🧩</div>
            <div style="flex:1;min-width:0">
              <div style="font-family:var(--font-heading);font-size:17px">{{ e.name }}</div>
              <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
                <span class="tag tag-neutral">v{{ e.version }}</span>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <!-- 唯一保留的操作：导出扩展安装包(zip)。装好/打开站点等流程已移到扩展自身。 -->
            <button type="button" class="btn btn-ghost" :disabled="exporting === e.dirName"
              @click="exportExt(e)">{{ exporting === e.dirName ? t('tools.packing') : t('tools.exportPkg') }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!ext.items.length && !extLoadError" class="empty">{{ t('tools.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
const { t } = useI18n();

// ── 浏览器扩展（独立于平台注入体系）──────────────────────────────────
type ExtInfo = {
  dirName: string; dir: string; name: string; version: string; description: string; matches: string[];
  siteUrl?: string; siteLabel?: string; guide?: string[];
};
// listExtensions 返回里还带 bridge 状态，但收口后页面不再渲染它（只有导出要用），故类型上只取需要的字段。
const ext = ref<{ baseDir: string | null; items: ExtInfo[]; bridge: any }>({
  baseDir: null,
  items: [],
  bridge: {},
});
const exporting = ref<string | null>(null);
const extLoadError = ref('');

async function loadExt() {
  try { ext.value = await window.api.listExtensions(); extLoadError.value = ''; }
  catch (e: any) {
    // D4(2026-08-05)：原 catch 静默 → 整个浏览器扩展分区因 v-if="ext.items.length" 凭空消失，
    // TA 以为没有这功能。改为显式报错 + 重试按钮，让入口看得见、故障可感知。
    extLoadError.value = e?.message || t('common.mainProcessNotReady');
  }
}

async function exportExt(e: ExtInfo) {
  exporting.value = e.dirName;
  try {
    const r = await window.api.exportExtension(e.dirName);
    if (r.canceled) return;                       // 用户自己取消，不是失败，不要弹错
    if (!r.ok) { ElMessage.error(r.reason || t('common.operationFailed')); return; }
    ElMessage.success(t('tools.msgExtExportDone'));
  } catch (err: any) {
    ElMessage.error(err?.message || t('common.operationFailed'));
  } finally {
    exporting.value = null;
  }
}

onMounted(loadExt);
</script>

<style scoped>
.tool-ico { width: 44px; height: 44px; flex: none; border-radius: var(--radius-md); background: var(--color-neutral-100); display: grid; place-items: center; font-size: 22px; }
</style>
