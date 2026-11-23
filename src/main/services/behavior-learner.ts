// S6: "模仿本人"行为学习 —— 采集用户手动 Sourcing 的操作节奏，拟合正态分布，
// 供 human（模拟真人）档整体替换默认节奏。
//
// 数据流：各平台 chrome.setBehaviorSampling/collectBehaviorSamples 采集 →
//         本服务定时 tick 读取累积 → IQR 去异常 + 拟合 {mean,std} →
//         存 DB('<platform>-behavior-learned') → resolveBehaviorProfile 在 human 档消费。
// 仅在 learnBehavior 开启且 RPA 未运行时采集。
//
// 2026-08-07 P1-6: 改为按平台实例化，不再写死 getRuntime('boss')。
// 猎聘在跑时仍往 BOSS 浏览器注入采样 / BOSS 学来的节奏被套到猎聘任务上，均已修复。
import { getDb, getSetting, setSetting } from '../db';
import { DEFAULT_SETTINGS, MIN_LEARN_SAMPLES } from '../../shared/constants';
import type { AppSettings, SpeedConfig, LearnedProfile, Dist, PlatformId } from '../../shared/types';
import { getRuntime } from './runtime-registry';

// 2026-08-07 P1-6: key 按平台命名空间，boss/liepin 的样本互不污染
const samplesKey = (platform: PlatformId) => `behavior-samples-${platform}`;
const learnedKey = (platform: PlatformId) => `behavior-learned-${platform}`;
// 向后兼容：boss 旧 key（无后缀）升级到新 key 时静默迁移
const LEGACY_SAMPLES_KEY = 'behavior-samples';
const LEGACY_LEARNED_KEY  = 'behavior-learned';
const MAX_SAMPLES = 800; // 加大到800，反映近1-2周节奏
const SAMPLE_WINDOW_DAYS = 14; // 样本有效期14天（滑动窗口，过期降权）

interface TimedSample { dt: number; at: number }
interface RawSamples {
  click: TimedSample[];
  scroll: TimedSample[];
  dwell: TimedSample[];
  type: TimedSample[]; // 打字间隔
}

function loadRaw(platform: PlatformId): RawSamples {
  // boss 平台：先尝试新 key，没有则从旧 key 迁移（一次性，无感）
  let raw = getSetting<any>(samplesKey(platform), null);
  if (!raw && platform === 'boss') {
    raw = getSetting<any>(LEGACY_SAMPLES_KEY, null);
  }
  const r = raw || { click: [], scroll: [], dwell: [], type: [] };
  const now = Date.now();
  const cutoff = now - SAMPLE_WINDOW_DAYS * 86400_000;
  const wrap = (arr: any): TimedSample[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => (typeof x === 'number' ? { dt: x, at: now } : x))
      .filter((x) => x && typeof x.dt === 'number' && x.dt > 0 && (x.at || 0) >= cutoff);
  };
  return { click: wrap(r.click), scroll: wrap(r.scroll), dwell: wrap(r.dwell), type: wrap(r.type || []) };
}
function saveRaw(platform: PlatformId, r: RawSamples) { setSetting(samplesKey(platform), r); }

// IQR 方法鲁棒拟合正态分布参数
function fitDist(samples: TimedSample[]): Dist | null {
  if (samples.length < 10) return null;
  // 时效性加权：越近的样本权重越高（7天内=1.0，7-14天线性衰减到0.3）
  const now = Date.now();
  const values = samples.map((s) => {
    const age = (now - s.at) / 86400_000;
    const w = age < 7 ? 1 : Math.max(0.3, 1 - (age - 7) / 7);
    return { v: s.dt, w };
  });
  const sorted = values.map((x) => x.v).sort((a, b) => a - b);
  // IQR 过滤异常值（离群< Q1-1.5*IQR 或 >Q3+1.5*IQR 剔除）
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const filtered = values.filter((x) => x.v >= lo && x.v <= hi);
  const arr = filtered.length >= 10 ? filtered : values;
  if (arr.length < 5) return null;
  // 2026-08-07 P1-4: 真正按 w（时效性权重）做加权均值；原来写成 wsum += s.dt; wtsum += 1
  // 等于普通平均，14 天衰减窗口形同虚设。
  let wsum = 0, wtsum = 0;
  for (const v of arr) { wsum += v.v * v.w; wtsum += v.w; }
  const mean = wtsum > 0 ? wsum / wtsum : arr.reduce((a, b) => a + b.v, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b.v - mean) * (b.v - mean) * b.w, 0) / (wtsum || 1);
  const std = Math.max(Math.sqrt(variance), mean * 0.15); // std下限防止机械感
  return { mean: Math.round(mean), std: Math.round(std) };
}

function fit(raw: RawSamples): LearnedProfile | null {
  const clickDist = fitDist(raw.click);
  if (!clickDist || raw.click.length < MIN_LEARN_SAMPLES) return null;
  const scrollDist = fitDist(raw.scroll);
  const dwellDist = fitDist(raw.dwell);
  const typeDist = fitDist(raw.type);
  // 2026-08-07 P1-4: dwell 样本不足时 pageStayMs 不再用 clickDist 顶替。
  // clickDist 是点击间隔（~300ms），pageStayMs 是页面停留时长（预设 6-22s），两者物理含义不同，
  // 用 clickDist 顶替会让学习后节奏直接变成机器速度。
  // 不足时置 undefined，resolveBehaviorProfile 会从 preset 取值（通过 clamp 兜底）。
  const profile: LearnedProfile['profile'] = {
    clickIntervalMs: clickDist,
    pageStayMs: dwellDist && raw.dwell.length >= 10 ? dwellDist : undefined,
  };
  if (scrollDist) profile.scrollDelayMs = scrollDist;
  if (typeDist) profile.typePerCharMs = typeDist;
  return { sampleCount: raw.click.length, updatedAt: Date.now(), profile };
}

// 2026-08-07 P1-6: 按平台实例化，不再写死 getRuntime('boss')。
// 猎聘跑时不再往 BOSS 浏览器注入采样；各平台的学习结果存在独立 key 下，互不污染。
export class BehaviorLearner {
  private readonly platform: PlatformId;
  private timer: NodeJS.Timeout | null = null;
  private raw: RawSamples = { click: [], scroll: [], dwell: [], type: [] };

  constructor(platform: PlatformId) {
    this.platform = platform;
  }

  private learnEnabled(): boolean {
    return !!getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS).rpa?.learnBehavior;
  }

  start() {
    this.raw = loadRaw(this.platform);
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 30_000);
    void this.syncSampling();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async syncSampling() {
    const rt = getRuntime(this.platform);
    const shouldSample = this.learnEnabled() && rt.engine.getState().status !== 'running';
    await rt.chrome.setBehaviorSampling(shouldSample).catch(() => {});
  }

  private async tick() {
    await this.syncSampling();
    const rt = getRuntime(this.platform);
    if (!this.learnEnabled() || rt.engine.getState().status === 'running') return;
    const samples = await rt.chrome.collectBehaviorSamples();
    if (!samples.length) return;
    const now = Date.now();
    for (const [kind, dt] of samples) {
      if (!isFinite(dt) || dt <= 0) continue;
      const s = { dt, at: now };
      if (kind === 'click') this.raw.click.push(s);
      else if (kind === 'scroll') this.raw.scroll.push(s);
      else if (kind === 'dwell') this.raw.dwell.push(s);
      else if (kind === 'type') this.raw.type.push(s);
    }
    const cutoff = now - SAMPLE_WINDOW_DAYS * 86400_000;
    const trimOld = (arr: TimedSample[]) => arr.filter((x) => x.at >= cutoff).slice(-MAX_SAMPLES);
    this.raw.click = trimOld(this.raw.click);
    this.raw.scroll = trimOld(this.raw.scroll);
    this.raw.dwell = trimOld(this.raw.dwell);
    this.raw.type = trimOld(this.raw.type);
    saveRaw(this.platform, this.raw);
    const learned = fit(this.raw);
    if (learned) setSetting(learnedKey(this.platform), learned);
  }

  applyNow(): LearnedProfile | null {
    this.raw = loadRaw(this.platform);
    const learned = fit(this.raw);
    if (learned) setSetting(learnedKey(this.platform), learned);
    return learned;
  }

  status(): { enabled: boolean; sampleCount: number; scrollCount: number; dwellCount: number; typeCount: number; learned: LearnedProfile | null } {
    const raw = loadRaw(this.platform);
    return {
      enabled: this.learnEnabled(),
      sampleCount: raw.click.length,
      scrollCount: raw.scroll.length,
      dwellCount: raw.dwell.length,
      typeCount: raw.type.length,
      learned: getSetting<LearnedProfile | null>(learnedKey(this.platform), null),
    };
  }

  reset() {
    this.raw = { click: [], scroll: [], dwell: [], type: [] };
    saveRaw(this.platform, this.raw);
    try { getDb().prepare('DELETE FROM settings WHERE key = ?').run(learnedKey(this.platform)); } catch {}
  }

  getLearnedProfile(): LearnedProfile | undefined {
    return getSetting<LearnedProfile | undefined>(learnedKey(this.platform), undefined);
  }
}

// 供引擎调用：human 档注入平台对应的学习分布
// 2026-08-07 P1-6: 加 platform 参数，按平台取对应的学习结果（不再全平台用同一套）
export function withLearnedProfile(speed: SpeedConfig, platform: PlatformId = 'boss'): SpeedConfig {
  const learned = getRuntime(platform).behaviorLearner.getLearnedProfile();
  return learned ? { ...speed, learned } : speed;
}
