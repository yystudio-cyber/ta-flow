// 匹配评分引擎（主进程入口）
// 实际评分逻辑在 src/shared/scoring-universal.js，与 content script 共用，避免双份实现分叉（修复 H10）
import type { CandidateProfile, JD, ScoreResult } from '../../shared/types';
import { existsSync } from 'fs';
import { join } from 'path';
import { getSetting } from '../db';

// 多路径兜底加载 scoring-universal.js：打包后相对路径层级会漂移（dist-electron/main 比源码浅一层），
// 故按 生产(dist-electron/shared) / 开发(src/shared) / 打包(asar 内) 依次探测，避免启动即崩。
// eslint-disable-next-line @typescript-eslint/no-var-requires
function loadUniversal(): any {
  const candidates = [
    join(__dirname, '../shared/scoring-universal.js'),        // 生产：dist-electron/main → dist-electron/shared
    join(__dirname, 'shared/scoring-universal.js'),
    join(process.cwd(), 'dist-electron/shared/scoring-universal.js'),
    join(process.cwd(), 'src/shared/scoring-universal.js'),   // 开发
  ];
  for (const p of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (existsSync(p)) return require(p);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../shared/scoring-universal.js'); // 最后回退（dev 相对路径）
}
const universal = loadUniversal();

// 多路径兜底查找（与 loadUniversal 同口径，开发/打包/asar 都兜住）
function tryResolve(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

// 语义 provider：src/shared/semantic-provider.js 与插件 content.bundle.js 共用同一份源。
// ⚠️ 开关必须与 scripts/build-ext.mjs 里的 SEMANTIC_ENABLED_IN_BUNDLE 严格一致——contract-check 会断言。
//
// ── 任务 B 决策已定（2026-08-03）：保持关闭 ──────────────────────────────────
// 三组对照跑完了（npm run score:eval -- --only=full --semantic=none|default|domain）：
//
//   semantic=none    分档命中 100%　MAE 1.5　最大偏差 3     ← 当前配置，最准
//   semantic=default 分档命中 100%　MAE 6.0　最大偏差 9
//   semantic=domain  分档命中  50%　MAE 7.0　最大偏差 10    ← 直接跌破合格线
//
// 开语义会把分数整体抬高并压缩档间距（锚点 B 从 63 → 69 → 70），排序仍对但标定变差。
// 所以结论是"不开"，而且这个结论现在是【有对照数据支撑的】：
// 2026-08-03 修掉了语义 provider 的静默归零 bug（未登录词文本相似度恒为 0，
// 见 scripts/semantic-lab.mjs 的说明），在那之前三组对照里的语义两组都是残废的，
// 比出来的结论不可信。修完再比，才敢把这个决策落定。
//
// 前提说明：锚点集目前只有 1 个岗位 2 个人，样本很薄。若将来锚点扩到 3 个岗位以上，
// 值得把这三组对照重跑一遍再确认——但在有新证据之前，默认就是关。
const SEMANTIC_ENABLED = false;
if (SEMANTIC_ENABLED) {
  try {
    const semPath = tryResolve([
      join(__dirname, '../shared/semantic-provider.js'),
      join(__dirname, 'shared/semantic-provider.js'),
      join(process.cwd(), 'dist-electron/shared/semantic-provider.js'),
      join(process.cwd(), 'src/shared/semantic-provider.js'),
    ]);
    if (semPath) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sem = require(semPath);
      universal.setSemanticProvider(sem.createSemanticProvider());
    }
  } catch (e: any) {
    console.warn('[scoring] 语义 provider 加载失败（已回退到纯字面匹配）：', e?.message || e);
  }
}

/**
 * @param tier 'card' = 列表卡片速评，'detail' = 打开详情后的深评。
 *   ★ 必须由调用方显式指定，不能靠引擎自动判。引擎的自动判定把 `education` 非空当作"深证据"，
 *   而 BOSS/猎聘的列表卡映射恒填 education（卡片上本来就显示学历），于是列表级评分被判成 detail：
 *   `CARD_MAX/CARD_MIN` 夹取与"卡片层不得评 high"这两条产品安全线在平台侧完全失效，
 *   同一个人在插件徽章上是 card/85/medium、在平台列表里却是 detail/97/high。
 *   插件侧一直是显式传的，两端因此对不上——2026-08-07 审查实测复现。
 */
export function scoreCandidate(c: CandidateProfile, jd: JD, tier?: 'card' | 'detail'): ScoreResult {
  // 归一化 CandidateProfile：评分引擎期望 experienceYears 是数字
  const normalized: any = {
    ...c,
    experienceYears: typeof c.experienceYears === 'number' ? c.experienceYears : undefined,
    skills: c.skills || [],
    workHistory: c.workHistory || [],
  };
  // 高/低匹配阈值由设置注入（settings.matchScore），使"设置里的阈值"真正生效
  let thresholds: { high?: number; low?: number } | undefined;
  try {
    const ms = getSetting<any>('app-settings', null)?.matchScore;
    if (ms) thresholds = { high: ms.highThreshold, low: ms.lowThreshold };
  } catch {
    /* 读设置失败则用默认阈值 */
  }
  // P1-24：透传 jd.weightTemplate 给引擎。若 JD 只写了 weightTemplate 没写 weights，
  // 引擎原来会静默回落到 default 模板——用户以为选的是 tech，实际用的是 default。
  const opts: any = {};
  if (tier) opts.tier = tier;
  if ((jd as any).weightTemplate && !(jd as any).weights) opts.weightTemplate = (jd as any).weightTemplate;
  return universal.scoreCandidate(normalized, jd, thresholds, opts);
}

export function parseBossSalary(salaryStr: string): { min: number; max: number } | null {
  return universal.parseSalary(salaryStr);
}

/** 本轮评分体检累加器（见 scoring-universal.js createScoreAudit 的说明） */
export interface ScoreAudit {
  count(): number;
  add(r: ScoreResult | null, c: CandidateProfile): void;
  report(jd: JD | null): string[];
}
export function createScoreAudit(): ScoreAudit {
  return universal.createScoreAudit();
}

// 解析 BOSS 列表卡片文本（列表页兜底）
export function parseBossCardText(text: string): CandidateProfile {
  const p: CandidateProfile = { skills: [] };
  if (!text) return p;
  const exp = text.match(/(\d+)(?:-\d+)?\s*年/);
  if (exp) p.experienceYears = parseInt(exp[1], 10);
  const salary = text.match(/(\d{1,3})-(\d{1,3})K/);
  if (salary) p.salary = `${salary[1]}-${salary[2]}K`;
  const degrees = ['博士', '硕士', '本科', '大专'];
  for (const d of degrees) {
    if (text.includes(d)) {
      p.degree = d;
      break;
    }
  }
  return p;
}

export { DEFAULT_WEIGHTS } from '../../shared/constants';
