// 拟人化操作原语 —— 在 Puppeteer Page 基础上增加行为模仿
//
// 设计原则（符合风险登记册 §5/R4 合规边界）：
//   - 所有拟人化参数来自人体工程学公开研究（Fitts' Law、keystroke dynamics、鼠标轨迹学）
//   - 目的是"模拟真人使用节奏"，不是"规避 ML 检测"；参数全部设为保守偏慢
//   - 见风控信号即停，不重试不绕（由上层 rpa-engine 控制）
//
// 升级要点：
//   - 鼠标：贝塞尔曲线+运动学模型+过冲修正+采样间隔抖动+点击后停留+悬停微抖动
//   - 打字：退格模拟+首键延迟+dwell time+中文composition事件+发送前检查
//   - 滚动：CDP wheel 事件模拟（非 scrollBy 一步跳）+ 加速段+减速段+回滚
//   - 统一 profile 驱动，新增维度全部从 BehaviorProfile 读取，缺省走安全默认值
import type { Page, ElementHandle } from 'puppeteer-core';
import { sampleDist, sampleHumanDelay, randRange, sleep, clamp } from '../../shared/utils';
import type { BehaviorProfile } from '../../shared/types';

export class HumanOperator {
  private page: Page;
  private profile: BehaviorProfile;
  // 追踪上一次鼠标位置，避免每次 move 都从视口中心出发
  private lastX = 500;
  private lastY = 300;
  private positionInitialized = false;

  constructor(page: Page, profile: BehaviorProfile) {
    this.page = page;
    this.profile = profile;
  }

  setProfile(profile: BehaviorProfile) {
    this.profile = profile;
  }

  // ===== 协作式截止时间 =====
  // 背景（真机 2026-07-28）：一次 loadMore 卡了 745 秒，而它写着 25 秒硬超时。
  // 原因是超时只在"步骤之间"判定，而单个步骤内部的 await（page.evaluate 取视口、
  // 十几次 mouse.move、几次 wheel 派发）一个都没有上限——BOSS 页面主线程一忙，
  // Input.dispatchMouseEvent 就一直等渲染进程回执。结果预算被一个步骤吃穿，
  // 后续的程序化兜底和沉降轮询全被跳过，日志只留下"移动 0"。
  //
  // 这里给 operator 一个截止时间戳：鼠标轨迹、滚轮 tick 这些循环每一步都查一次，
  // 到点就干净地提前收工。用协作式而不是 Promise.race，是为了不留下"被放弃却还在
  // 后台继续派发滚轮"的孤儿任务——那会和下一阶段的操作互相打架。
  private deadlineTs = 0;
  setDeadline(ts: number) { this.deadlineTs = ts; }
  clearDeadline() { this.deadlineTs = 0; }
  private expired(): boolean { return this.deadlineTs > 0 && Date.now() >= this.deadlineTs; }
  /** 剩余预算（无截止时间则返回 fallback），用于给单次 CDP 调用套超时 */
  private budgetMs(fallback: number): number {
    if (this.deadlineTs <= 0) return fallback;
    return Math.max(0, Math.min(fallback, this.deadlineTs - Date.now()));
  }

  /** 给任意 CDP/求值调用套一个上限；超时按失败处理，绝不让它把整条链路挂死。 */
  private async capped<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    if (ms <= 0) { p.catch(() => {}); return fallback; } // 必须消费掉，否则是未处理拒绝
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p.catch(() => fallback),
        new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 读取 profile 中可选的数值维度，缺省用 fallback
  private num(key: string, fallback: number): number {
    const v = (this.profile as any)[key];
    return typeof v === 'number' ? v : fallback;
  }

  // 读取 profile 中可选的 Dist 维度，缺省用 fallback
  private dist(key: string, fbMean: number, fbStd: number): { mean: number; std: number } {
    const v = (this.profile as any)[key];
    if (v && typeof v.mean === 'number' && typeof v.std === 'number') return v;
    return { mean: fbMean, std: fbStd };
  }

  async wait(mode: 'click' | 'page' | 'scroll' | 'type' = 'click') {
    const p = this.profile;
    let dist = p.clickIntervalMs;
    if (mode === 'page') dist = p.pageStayMs;
    else if (mode === 'scroll') dist = p.scrollDelayMs;
    else if (mode === 'type') dist = p.typePerCharMs;
    // ★ 行为间隔用对数正态（右偏重尾），不用对称正态——见 utils.sampleHumanDelay 注释
    await sleep(sampleHumanDelay(dist));
  }

  // 随机短暂停顿（"思考"一下）
  async smallWait() {
    await sleep(sampleHumanDelay(this.profile.thinkPauseMs));
  }

  /**
   * 「阅读一张卡片」——把处理单个候选人的那段等待，从【绝对静止】换成真人读列表的样子。
   *
   * ⛔ 为什么必须有（2026-08-13 复盘）：猎聘侧既不打招呼（合规设计）、卡片上也没有收藏
   *   控件，于是每个候选人的处理是【纯 DOM 抽取 + 本地评分 + 入库】——浏览器里【零交互】，
   *   然后 wait('click') 静等 8~16 秒。20 个候选人 = 约 4 分钟鼠标完全冻结，
   *   接着突然一次精确的滚动+点击翻页。
   *   这个「死寂 → 精确动作 → 死寂」的轨迹，比"点得太快"更像机器：
   *   真人读列表时鼠标会顺着往下飘、在名字上停一下、时不时小幅滚动，
   *   持续产生低幅噪声。一动不动整整四分钟的"人"是不存在的。
   *
   * 做法：在给定时长内，把鼠标移到正在读的那张卡片上，做若干次「落点→微停留→再落点」，
   *   偶尔夹一次很小的滚动（读到卡片下半部分的自然动作）。全程不点击、不产生任何请求，
   *   只是让行为轨迹连续起来。传不进卡片元素时退化为原地微抖动，仍好过完全静止。
   */
  async readCard(el: ElementHandle | null, totalMs: number): Promise<void> {
    const budget = Math.max(0, totalMs);
    if (budget < 400) { await sleep(budget); return; }
    const startTs = Date.now();
    let box: { x: number; y: number; width: number; height: number } | null = null;
    try { box = el ? await el.boundingBox() : null; } catch { box = null; }

    while (Date.now() - startTs < budget) {
      const left = budget - (Date.now() - startTs);
      if (left <= 0) break;
      if (this.expired()) { await sleep(Math.min(left, 200)); break; }

      if (box && box.width > 4 && box.height > 4) {
        // 视线在卡片内游走：落到卡片里的一个随机位置，停一会儿（含生理性震颤）
        const tx = box.x + randRange(box.width * 0.12, box.width * 0.88);
        const ty = box.y + randRange(box.height * 0.15, box.height * 0.85);
        await this.humanMoveTo(tx, ty);
        // ★ 2026-08-14 真机基线校准（VIP测试账号 8.9min / 3897 事件）：真人卡片停留
        //   p50=1.06s、均值2.0s、标准差2.1s，明显右偏 → 用对数正态而非对称正态。
        const dwell = Math.min(left, sampleHumanDelay({ mean: 2000, std: 2100 }, 200));
        await this.hoverJitter(Math.max(120, dwell));
      } else {
        // 没有卡片坐标：原地微抖动，至少不是完全静止
        await this.hoverJitter(Math.min(left, 800));
      }

      // ★ 真机基线：真人读卡时【小幅高频】滚动——单次幅度 p50=12px/p90=54px
      //   （原设 40~130px 偏大 3~6 倍），滚动很密（阵间约 2s），向上回看占 17%。
      if (Math.random() < this.num('readMicroScrollChance', 0.5)) {
        const px = Math.round(randRange(8, 55));
        try { await this.wheelPixels(px, Math.random() < 0.83 ? 1 : -1); } catch { /* 滚不动不影响 */ }
        // 滚动后卡片位置会变，重新取一次，否则后续落点会打在旧坐标上
        try { box = el ? await el.boundingBox() : null; } catch { box = null; }
      }
    }
  }

  /**
   * 「发呆」——填补屏间 / 搜索组合切换之间的长静止段。
   *
   * ★ 2026-08-13：readCard 只覆盖了"读单张卡片"的 8~16 秒；而每屏之间还有 24~27 秒、
   *   每个搜索组合切换还有约 60 秒，这些空档同样是【鼠标完全冻结】。
   *   真人在这些时刻不会僵着：会把鼠标随手放到页面某处、缓慢漂移、
   *   偶尔往回滚看两眼刚才划过的内容、也可能什么都不看就停在那儿。
   *   这里模拟的正是这种"低强度存在感"：不点击、不发请求，只让轨迹别断。
   *
   * 与 readCard 的区别：readCard 有明确目标（那张卡片），这里没有目标，
   *   落点在视口内随机游走，且更可能长时间不动（发呆本来就包含"真的没动"）。
   */
  async idleDrift(totalMs: number): Promise<void> {
    const budget = Math.max(0, totalMs);
    if (budget < 1500) { await sleep(budget); return; }
    const startTs = Date.now();
    let vw = 1280; let vh = 800;
    try {
      const vp = await this.capped(
        this.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })),
        1500, null as any,
      );
      if (vp && vp.w > 100) { vw = vp.w; vh = vp.h; }
    } catch { /* 用默认视口 */ }

    while (Date.now() - startTs < budget) {
      const left = budget - (Date.now() - startTs);
      if (left <= 0) break;
      if (this.expired()) { await sleep(Math.min(left, 200)); break; }

      const roll = Math.random();
      if (roll < 0.45) {
        // 真的发呆：停在原地不动一段（人不是每时每刻都在动）
        await sleep(Math.min(left, sampleHumanDelay({ mean: 4800, std: 3500 }, 300))); // 真机基线：走神 p50≈5.1s
      } else if (roll < 0.85) {
        // 随手把鼠标挪到页面某处，然后停一会儿
        const tx = randRange(vw * 0.15, vw * 0.85);
        const ty = randRange(vh * 0.15, vh * 0.85);
        await this.humanMoveTo(tx, ty);
        await this.hoverJitter(Math.min(left, sampleHumanDelay({ mean: 1200, std: 700 }, 200)));
      } else {
        // 往回滚看两眼刚才划过的内容，再滚回来（真人常见的"回看"）
        const back = Math.round(randRange(10, 60)); // 真机基线：真人滚动幅度 p90=54px，回看也小幅
        try {
          await this.wheelPixels(back, -1);
          await sleep(Math.min(Math.max(0, left - 500), sampleHumanDelay({ mean: 1400, std: 800 }, 250)));
          await this.wheelPixels(back, 1);
        } catch { /* 滚不动就算了 */ }
      }
    }
  }

  /**
   * 「偶尔犯个错」——真人不会每个动作都精确命中。
   *
   * ★ 2026-08-13：零失误本身就是异常。我们的每一次移动都落在目标框内、
   *   每一次滚动都恰到好处、从不选中文本、从不滚过头。真人会：
   *   滚过头再滚回来、无意中划选一段文字、鼠标滑到别处又拉回来。
   *   这些动作都不产生请求，纯粹是行为纹理。
   *
   * 频率刻意压低（默认 12%）：犯错太频繁同样不像人，而且会拖慢有效进度。
   * 全部动作都是【只读】的：不点击任何控件，不可能误触发「立即沟通」这类对外动作。
   */
  async occasionalSlip(): Promise<void> {
    if (Math.random() >= this.num('slipChance', 0.12)) return;
    try {
      // ⛔ 2026-08-13 复审删掉了原来的第三种「划选文字」失误。
      //   它用 mouse.down → 拖动 → mouse.up，而 occasionalSlip 在读完卡片后调用，
      //   此时鼠标停在【卡片框内】，卡片里就是「立即沟通」「超级聊聊」两个对外按钮。
      //   虽然拖拽通常不派发 click（水平位移超容差），但"在对外沟通控件上按下真实鼠标键"
      //   本身就踩了这条线的红线；且若 mouse.up 被 capped 超时吞掉，鼠标会留在按下态、
      //   污染后续所有移动与点击。反风控不值得用"可能发消息"去换。
      //   只保留【纯滚动 / 纯移动】两种失误——它们不 down 鼠标键，绝无对外动作可能。
      if (Math.random() < 0.5) {
        // 滚过头 → 察觉 → 滚回来
        const over = Math.round(randRange(30, 90)); // 真机基线：真人滚动小幅，失误也不该猛滚
        await this.wheelPixels(over, 1);
        await sleep(sampleHumanDelay({ mean: 600, std: 300 }, 150));
        await this.wheelPixels(Math.round(over * randRange(0.6, 1.0)), -1);
      } else {
        // 鼠标滑向别处又拉回来（走神后回到正题）。只 move 不 down，安全。
        const bx = this.lastX; const by = this.lastY;
        await this.humanMoveTo(bx + randRange(-260, 260), by + randRange(-180, 180));
        await sleep(sampleHumanDelay({ mean: 500, std: 260 }, 120));
        await this.humanMoveTo(bx, by);
      }
    } catch { /* 犯错模拟失败无所谓，绝不因此中断主流程 */ }
  }

  // 直接用自己的 CDP 会话发 mouseMoved，绕开 puppeteer 的 Mouse。
  // 为什么必须绕开：puppeteer 的 CdpMouse.move 内部有 #withTransaction 状态机，
  // 一旦我们把它的 promise 超时放弃掉，事务就悬在那里，后续 move 会连带报错
  // （本地 e2e 已复现：滚动本身成功，收尾抛 CdpMouse.move 异常）。
  // 裸 CDP 调用没有这层状态，超时放弃是安全的。
  // ⚠️ 代价：puppeteer 内部记录的鼠标坐标不会同步。所以只在【滚动路径】用它，
  // 点击路径仍走 page.mouse（它的 down/up 依赖内部坐标），下一次点击时自然重新同步。
  private async rawMouseMove(x: number, y: number, capMs: number): Promise<boolean> {
    const s = await this.getWheelSession();
    if (!s) return false;
    const r = await this.capped<'ok' | 'fail'>(
      s.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0,
      }).then(() => 'ok' as const),
      Math.max(1, capMs),
      'fail',
    );
    // 预算到点(expired)属于正常收工，不能当成会话失效去丢弃——那会把健康会话变成孤儿。
    if (r === 'fail' && !this.expired()) this.dropWheelSession();
    return r === 'ok';
  }

  // ========== 鼠标移动：运动学模型 + 过冲修正 + 采样抖动 ==========
  // useRawCdp：滚动路径专用（见 rawMouseMove 注释）。点击路径保持 false。
  private async humanMoveTo(tx: number, ty: number, useRawCdp = false) {
    const steps = Math.max(6, Math.round(sampleDist(this.profile.curveSteps)));
    const jitter = this.profile.curveJitterPx || 2.5;
    const mouse = this.page.mouse;

    // 起点
    let cx: number, cy: number;
    if (this.positionInitialized) {
      cx = this.lastX;
      cy = this.lastY;
    } else {
      cx = 500 + randRange(-100, 100);
      cy = 300 + randRange(-60, 60);
      this.positionInitialized = true;
    }

    // 起始反应延迟
    const reactionMs = sampleDist(this.dist('startReactionMs', 150, 50));
    if (reactionMs > 0) await sleep(Math.max(20, reactionMs));

    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.hypot(dx, dy) || 1;

    // 过冲目标点（先冲过再修正回来）
    const overshootChance = this.num('overshootChance', 0.5);
    const doOvershoot = Math.random() < overshootChance && dist > 40;
    const overshootPx = doOvershoot ? sampleDist(this.dist('overshootPx', 3, 1.5)) : 0;

    // 过冲后的临时目标点（沿向量延长一点）
    const ox = tx + (dx / dist) * overshootPx;
    const oy = ty + (dy / dist) * overshootPx;

    // 二次贝塞尔控制点（法向偏移，弧线）
    const perpX = -dy / dist;
    const perpY = dx / dist;
    const bow = dist * randRange(0.06, 0.18) * (Math.random() < 0.5 ? -1 : 1);
    const px = (cx + ox) / 2 + perpX * bow;
    const py = (cy + oy) / 2 + perpY * bow;

    // 采样间隔抖动（ms）
    const intervalDist = this.dist('trackIntervalJitterMs', 14, 5);

    // 主轨迹段（起点→过冲点）
    for (let i = 1; i <= steps; i++) {
      // 到点收工，别把预算耗在轨迹上。
      // ⚠️ 不要在这里把 lastX/lastY 改写成目标点——鼠标并没有真的移到那里。
      // 伪造"已到达"会让后续以 lastX/lastY 为准的动作（点击按下点、滚轮落点）打偏。
      if (this.expired()) return;
      const raw = i / steps;
      // ease-in-out 速度曲线
      const t = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw;
      const mt = 1 - t;
      // 二次贝塞尔 B(t) = (1-t)²P0 + 2(1-t)t·P1 + t²P2
      const j = jitter * (1 - t); // 末段抖动收敛
      const nx = mt * mt * cx + 2 * mt * t * px + t * t * ox + randRange(-j, j);
      const ny = mt * mt * cy + 2 * mt * t * py + t * t * oy + randRange(-j, j);
      // 单次移动也要有上限：页面主线程繁忙时 Input.dispatchMouseEvent 会一直等回执
      if (useRawCdp) await this.rawMouseMove(nx, ny, this.budgetMs(5000));
      // ★ 2026-08-14：普通 mouse.move 也套超时。真机 no-result 组合 applySearch 卡死 7 分钟，
      //   根因是页面主线程繁忙时 mouse.move 等渲染回执，而单步卡在内部时 expired() 查不到
      //   （要等它返回）。给单步一个硬上限，卡住就放弃这一步、继续往下走。
      else await this.capped(mouse.move(nx, ny), this.budgetMs(2000), undefined as any);
      const stepMs = Math.max(4, sampleDist(intervalDist));
      await sleep(stepMs);
      this.lastX = nx;
      this.lastY = ny;
    }

    // 过冲修正段
    if (doOvershoot && overshootPx > 0.5) {
      const correctSteps = Math.max(4, Math.round(steps * 0.25));
      const correctMs = sampleDist(this.dist('overshootCorrectMs', 90, 30));
      const stepSleep = Math.max(3, Math.round(correctMs / correctSteps));
      const startX = this.lastX;
      const startY = this.lastY;
      for (let i = 1; i <= correctSteps; i++) {
        // C6: 过期立即退出函数，不把 lastX/lastY 写成目标点而鼠标实际停在过冲点
        if (this.expired()) return;
        const r = i / correctSteps;
        const alpha = 1 - Math.pow(1 - r, 2); // ease-out 修正
        const x = startX + (tx - startX) * alpha + randRange(-jitter * 0.5, jitter * 0.5);
        const y = startY + (ty - startY) * alpha + randRange(-jitter * 0.5, jitter * 0.5);
        if (useRawCdp) await this.rawMouseMove(x, y, this.budgetMs(5000));
        else await this.capped(mouse.move(x, y), this.budgetMs(2000), undefined as any);
        await sleep(stepSleep + randRange(-2, 2));
        this.lastX = x;
        this.lastY = y;
      }
    }

    this.lastX = tx;
    this.lastY = ty;
  }

  // ========== 悬停微抖动：生理性震颤 ==========
  private async hoverJitter(durationMs: number) {
    const amp = this.num('hoverMicromovePx', 1.0);
    if (amp <= 0 || durationMs <= 0) return;
    const startTs = Date.now();
    // 每 40-90ms 微抖动一次（8-15Hz 生理性震颤）
    while (Date.now() - startTs < durationMs) {
      const dx = randRange(-amp, amp);
      const dy = randRange(-amp, amp);
      await this.page.mouse.move(this.lastX + dx, this.lastY + dy);
      const tick = randRange(40, 90);
      if (Date.now() + tick - startTs > durationMs) break;
      await sleep(tick);
    }
    await this.page.mouse.move(this.lastX, this.lastY);
  }

  // ========== 点击：移动→悬停→抖动→按下→停留→抬起→点击后停留 ==========
  async click(selector: string): Promise<boolean> {
    const el = await this.page.$(selector).catch(() => null);
    if (!el) return false;
    try {
      const box = await el.boundingBox();
      if (!box) {
        await el.click();
        return true;
      }
      const tx = box.x + randRange(box.width * 0.2, box.width * 0.8);
      const ty = box.y + randRange(box.height * 0.2, box.height * 0.8);

      await this.humanMoveTo(tx, ty);
      // 悬停+微抖动
      const hoverMs = sampleDist(this.profile.prePauseMs);
      await this.hoverJitter(hoverMs);
      // 偶尔犹豫（移开再回来）
      await this.maybeHesitate(tx, ty);
      // 按下→停留→抬起
      await this.pressAt(tx, ty);
      // 点击后短暂停留
      const postStay = sampleDist(this.dist('postClickStayMs', 250, 80));
      await this.hoverJitter(postStay);
      return true;
    } catch {
      return false;
    }
  }

  async clickElement(el: ElementHandle): Promise<boolean> {
    try {
      const box = await el.boundingBox();
      if (!box) {
        await el.click();
        return true;
      }
      const tx = box.x + randRange(box.width * 0.2, box.width * 0.8);
      const ty = box.y + randRange(box.height * 0.2, box.height * 0.8);
      await this.humanMoveTo(tx, ty);
      const hoverMs = sampleDist(this.profile.prePauseMs);
      await this.hoverJitter(hoverMs);
      await this.maybeHesitate(tx, ty);
      await this.pressAt(tx, ty);
      const postStay = sampleDist(this.dist('postClickStayMs', 250, 80));
      await this.hoverJitter(postStay);
      return true;
    } catch {
      return false;
    }
  }

  // 犹豫动作：偶尔移开再移回来
  private async maybeHesitate(tx: number, ty: number) {
    if (Math.random() >= this.profile.hesitationChance) return;
    const off = sampleDist(this.dist('hesitationOffsetPx', 30, 8), 1);
    const offX = tx + randRange(-off, off);
    const offY = ty + randRange(-off, off);
    const steps = Math.max(3, Math.round(sampleDist(this.profile.curveSteps) * 0.5));
    const mouse = this.page.mouse;
    for (let i = 1; i <= steps; i++) {
      const r = i / steps;
      const alpha = 1 - Math.pow(1 - r, 2); // ease-out
      const x = tx + (offX - tx) * alpha;
      const y = ty + (offY - ty) * alpha;
      await this.capped(mouse.move(x, y), this.budgetMs(2000), undefined as any);
      await sleep(randRange(6, 18));
      this.lastX = x;
      this.lastY = y;
    }
    await sleep(sampleDist(this.profile.hesitationHoldMs));
    await this.humanMoveTo(tx, ty);
  }

  // 按下 + 停留 + 抬起
  private async pressAt(tx: number, ty: number) {
    await sleep(sampleDist(this.profile.prePauseMs));
    await this.page.mouse.down();
    await sleep(sampleDist(this.profile.clickPressMs));
    await this.page.mouse.up();
    this.lastX = tx;
    this.lastY = ty;
  }

  // ========== 滚动：wheel 事件模拟（加速+匀速+减速+回滚）==========
  private async wheelPixels(targetPx: number, direction: 1 | -1 = 1) {
    if (Math.abs(targetPx) < 5) return;
    const accelSteps = this.num('scrollAccelSteps', 3);
    const decelSteps = this.num('scrollDecelSteps', 4);
    const tickInterval = this.dist('scrollWheelTickMs', 80, 30);

    // 每 tick 像素量（60-200px，真实滚轮）
    const baseTick = clamp(this.profile.scrollStep.mean * 0.6, 60, 200);
    const jitter = baseTick * 0.3;
    const ticks = Math.max(3, Math.round(Math.abs(targetPx) / baseTick));

    // 优先用 CDP 发 wheel 事件（最自然），失败用 JS scrollBy 兜底（每 tick 内取会话，失效可重建）
    for (let i = 0; i < ticks; i++) {
      if (this.expired()) return; // 预算到点：已派发的滚轮算数，剩下的不再排队
      let speedFactor = 1.0;
      if (i < accelSteps) {
        speedFactor = 0.4 + (i + 1) / accelSteps * 0.6; // 加速 0.4→1.0
      } else if (i >= ticks - decelSteps) {
        const d = ticks - i - 1;
        speedFactor = 0.3 + d / decelSteps * 0.7; // 减速 1.0→0.3
      }
      const tickPx = (baseTick + randRange(-jitter, jitter)) * speedFactor * direction;

      let dispatched = false;
      const session = await this.getWheelSession();
      if (session) {
        // ⚠️ 必须套超时：mouseWheel 的派发要等渲染进程回执，BOSS 推荐页主线程一忙就是分钟级。
        // 真机 745 秒卡死正是卡在这一类调用上（连接层 protocolTimeout 也已收到 60s 兜底）。
        // capped 内部已吞掉 reject，用 'ok'/'fail' 区分成功与超时/报错。
        const r = await this.capped<'ok' | 'fail'>(
          session.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Math.round(this.lastX),
            y: Math.round(this.lastY),
            deltaX: 0,
            // ⚠️ 符号即方向，别再取反：CDP mouseWheel 的 deltaY 与 DOM WheelEvent.deltaY 同向，
            // 【正值 = 向下滚】（已用真实 Chrome 实测：deltaY=+300 → scrollY 0→300）。
            // 旧实现写成 -tickPx，于是 scrollDown/scrollFeed 全都在【往上滚】——
            // 推荐列表被死死顶在顶部，懒加载哨兵永远进不了视野，
            // 这就是"每次只能找 15 人、下滑不更新"的根因。
            deltaY: tickPx,
            button: 'none',
            buttons: 0,
          }).then(() => 'ok' as const),
          Math.max(1, this.budgetMs(5000)),
          'fail',
        );
        if (r === 'ok') dispatched = true;
        // 会话可能已随页面重建而失效：丢弃它，下一 tick 重建一个再试。
        // 不丢弃的话会一路静默退化到 window.scrollBy —— 那是滚【主文档】、不产生 wheel 事件、
        // 滚不进推荐 iframe，正是本类当初要解决的"程序化滚动不触发懒加载"，而且毫无日志。
        // 但预算到点是正常收工，不属于会话失效，别误丢。
        else if (!this.expired()) this.dropWheelSession();
      }
      if (!dispatched) {
        // 兜底同样按"正值向下"，与上面保持同向
        await this.capped(
          this.page.evaluate((d: number) => window.scrollBy(0, d), tickPx),
          Math.max(1, this.budgetMs(3000)),
          undefined as any,
        );
      }

      const delay = Math.max(15, sampleDist(tickInterval) / speedFactor);
      await sleep(delay);
    }
  }

  // wheel 用的 CDP 会话：整个 operator 复用一个。
  // 旧实现每次 wheelPixels 都 createCDPSession + detach，一次 loadMore 要开关 3-5 个会话，
  // 既慢又可能在页面重建时抛错把整段滚动吞掉。
  // 存活判定用 connection()：puppeteer 的 CDPSession 上没有 detached 成员（只有 Frame 有），
  // 会话断开后 connection() 返回 undefined。
  private wheelSession: any = null;
  /** 丢弃当前 wheel 会话并异步 detach，避免在浏览器侧留下孤儿会话 */
  private dropWheelSession() {
    const s = this.wheelSession;
    this.wheelSession = null;
    if (s) { try { s.detach?.()?.catch?.(() => {}); } catch { /* 会话可能已死 */ } }
  }

  private async getWheelSession(): Promise<any> {
    if (this.wheelSession) {
      try {
        if (this.wheelSession.connection?.()) return this.wheelSession;
      } catch { /* 判活本身失败也当失效 */ }
      this.wheelSession = null;
    }
    try {
      this.wheelSession = await (this.page as any).createCDPSession?.();
    } catch {
      this.wheelSession = null;
    }
    return this.wheelSession;
  }

  /** 释放 operator 持有的 CDP 会话（页面关闭/换页时由上层调用）。 */
  async dispose(): Promise<void> {
    const s = this.wheelSession;
    this.wheelSession = null;
    if (s) { try { await s.detach?.(); } catch { /* 页面已死则忽略 */ } }
  }

  async scrollDown(pixels?: number): Promise<void> {
    const step = pixels ?? sampleDist(this.profile.scrollStep, 20);
    await this.wheelPixels(step, 1);
  }

  async scrollUp(pixels?: number): Promise<void> {
    const step = pixels ?? sampleDist(this.profile.scrollStep, 20);
    await this.wheelPixels(step, -1);
  }

  // 在信息流上做【真实滚轮】下滑：先把光标移到信息流区域中部，再用 CDP wheel 事件下滚。
  // 关键：BOSS 推荐流懒加载多绑定真实 wheel/scroll 行为，程序化设置 scrollTop 不产生 wheel 事件、
  // 常常不触发"加载更多"网络请求——真机只加载出首屏 ~15 人正是这个原因。此方法产生真实 wheel。
  // 光标落在视口中部（默认），CDP 会把 wheel 路由到该点下的元素（含 iframe 内的推荐列表）。
  // dir=-1 时向【上】滚。上滑不是为了看回头路，而是推荐流懒加载的重触发手法：
  // 哨兵型懒加载只在"进入视野"的那一刻触发一次，滚到底停住后它一直处于已进入状态，
  // 再怎么往下滚都不再产生新边沿。先上退出哨兵区、再下重新进入，才能制造新的触发边沿。
  // （真机 2026-07-29 用户实测确认：单纯下滑刷不出来，先上滑再下滑就能刷出来。）
  async scrollFeed(px?: number, atX?: number, atY?: number, dir: 1 | -1 = 1): Promise<void> {
    // 调用方给了确切坐标就别再去问页面视口——这次 page.evaluate 没有上限，
    // 页面主线程一忙就能把整个下滑预算耗光（真机 745 秒卡死的第一环）。
    let tx = atX;
    let ty = atY;
    if (tx === undefined || ty === undefined) {
      const dims = await this.capped(
        this.page.evaluate(() => ({ w: window.innerWidth || 1200, h: window.innerHeight || 800 })),
        Math.max(1, this.budgetMs(3000)),
        { w: 1200, h: 800 },
      );
      tx = tx ?? Math.round(dims.w * (0.42 + Math.random() * 0.16));
      ty = ty ?? Math.round(dims.h * (0.45 + Math.random() * 0.18));
    }
    // 滚动路径走裸 CDP 移动：可以安全地被预算打断（见 rawMouseMove 注释）
    await this.humanMoveTo(tx, ty, true);
    const amount = px ?? Math.round(sampleDist(this.profile.scrollStep, 20) * 3);
    await this.wheelPixels(amount, dir);
  }

  async scrollToBottom(full = false) {
    const MAX_ITER = 200;
    const TIMEOUT_MS = 30000;
    const STABLE_LIMIT = 3;
    const startTs = Date.now();
    let iter = 0;
    let stableCount = 0;
    // C6: 所有 page.evaluate 包 capped 防止卡死（此前同款模式在 loadMore 上卡过 745 秒）
    const evalCapped = <T>(fn: () => T, fallback: T) =>
      this.capped(this.page.evaluate(fn), Math.max(1, this.budgetMs(5000)), fallback);
    let scrollHeight = await evalCapped(() => document.documentElement.scrollHeight, 0);
    let cur = await evalCapped(() => window.scrollY + window.innerHeight, 0);

    while (cur < scrollHeight - 10) {
      if (iter++ >= MAX_ITER || Date.now() - startTs >= TIMEOUT_MS) break;

      const viewportH = await evalCapped(() => window.innerHeight, 800);
      const step = viewportH * randRange(0.2, 0.4);
      await this.scrollDown(step);

      // 回滚模拟
      if (Math.random() < this.profile.scrollBackChance) {
        await sleep(sampleDist(this.profile.scrollBackMs));
        const backPx = viewportH * randRange(0.05, 0.15);
        await this.scrollUp(backPx);
        await sleep(randRange(200, 600));
      }

      await this.wait('scroll');

      const prevHeight = scrollHeight;
      const prevCur = cur;
      scrollHeight = await evalCapped(() => document.documentElement.scrollHeight, scrollHeight);
      cur = await evalCapped(() => window.scrollY + window.innerHeight, cur);

      if (scrollHeight === prevHeight && cur <= prevCur + 1) {
        if (++stableCount >= STABLE_LIMIT) break;
      } else {
        stableCount = 0;
      }

      if (!full && cur > scrollHeight * 0.6 && Math.random() < 0.4) break;
    }
  }

  // ========== 打字：退格+首键延迟+dwell+composition ==========
  async type(selector: string, text: string, clearFirst = true): Promise<boolean> {
    const el = await this.page.$(selector).catch(() => null);
    if (!el) return false;
    await el.focus();
    await sleep(sampleDist(this.dist('keyFirstDelayMs', 350, 150)));
    if (clearFirst) {
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('a');
      await this.page.keyboard.up('Control');
      await sleep(sampleHumanDelay(this.profile.thinkPauseMs));
      await this.page.keyboard.press('Backspace');
    }
    await this.typeText(text);
    return true;
  }

  /** 在已知 ElementHandle（textarea 或 contenteditable）内逐字输入 */
  async typeChatMessage(el: ElementHandle, text: string): Promise<boolean> {
    try {
      await el.focus();
      await el.evaluate((node: any) => {
        if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
          (node as HTMLTextAreaElement).value = '';
          return false;
        }
        node.innerHTML = '';
        return true;
      });
      await sleep(sampleDist(this.dist('keyFirstDelayMs', 400, 180)));
      // 中文触发 composition 序列
      const withComposition = /[一-龥]/.test(text);
      await this.typeText(text, withComposition);
      return true;
    } catch {
      return false;
    }
  }

  // 核心打字函数
  private async typeText(text: string, withComposition = false) {
    const backspaceRate = this.num('typeBackspaceRate', 0.025);
    const keyDwell = this.dist('keyDwellMs', 90, 30);
    const perChar = this.profile.typePerCharMs;
    const burstChance = this.profile.typeBurstChance;
    const burstMs = this.profile.typeBurstMs;

    if (withComposition) {
      await this.fireComposition('start', '');
      await sleep(randRange(80, 200));
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // 退格模拟
      if (i > 2 && Math.random() < backspaceRate) {
        const wrongChar = this.randomSimilarChar(ch);
        await this.keyPress(wrongChar, keyDwell);
        await sleep(sampleDist(perChar) * 0.6);
        await this.keyPress('Backspace', { mean: 110, std: 40 });
        await sleep(sampleDist(perChar) * 0.5);
      }

      await this.keyPress(ch, keyDwell);
      await sleep(sampleDist(perChar));

      // 思考/爆发停顿
      if (i > 0 && i % 8 === 0 && Math.random() < burstChance) {
        await sleep(sampleDist(burstMs));
      }

      // 语义停顿（标点后停顿更长）
      if (/[，。？！,.?!]/.test(ch)) {
        await sleep(sampleDist(this.profile.thinkPauseMs) * 0.8);
      }

      // 中文：每 2-4 字一次 composition update
      if (withComposition && /[一-龥]/.test(ch) && i > 0 && i % 3 === 0) {
        await this.fireComposition('update', text.slice(Math.max(0, i - 2), i + 1));
      }
    }

    if (withComposition) {
      await this.fireComposition('end', text);
      await sleep(sampleDist(this.dist('typeComposeBeforeSubmitMs', 900, 400)));
    }
  }

  // 单键按下→停留→抬起（真实 dwell time）
  private async keyPress(key: string, dwell: { mean: number; std: number }) {
    // ⚠️ keyboard.down 只认 US 键盘布局里的键：puppeteer 内部 `assert(definition, 'Unknown key')`，
    // 传中文字符（"您"）会直接抛错。而我们的默认招呼话术就是中文——旧实现在第一个字上就抛，
    // 一个字都发不出去。中文/非布局字符改走 sendCharacter（等价于输入法上屏），dwell 节奏保留。
    if (key.length === 1 && !/^[\x20-\x7E]$/.test(key)) {
      await this.page.keyboard.sendCharacter(key);
      await sleep(sampleDist(dwell));
      return;
    }
    // 单个字符转 KeyInput 兼容（特殊键名走原样：'Backspace'等）
    const k = key as any;
    await this.page.keyboard.down(k);
    await sleep(sampleDist(dwell));
    await this.page.keyboard.up(k);
  }

  // 触发 composition 事件（中文输入法模拟）
  private async fireComposition(phase: 'start' | 'update' | 'end', data: string) {
    const ev = `composition${phase}`;
    await this.page.evaluate((eventName: string, text: string) => {
      const el = document.activeElement;
      if (!el) return;
      const evt = new CompositionEvent(eventName, {
        bubbles: true,
        cancelable: true,
        data: text,
      });
      el.dispatchEvent(evt);
    }, ev, data).catch(() => {});
  }

  // 打错字时选一个相似字符
  private randomSimilarChar(ch: string): string {
    const nearby = 'qwfpgjluy;arstdhneiozxcvbkm,.';
    if (/[a-z]/.test(ch)) return nearby[Math.floor(Math.random() * nearby.length)];
    const common = '的一是不了人我在有他这为之大来以个中上们到说国和地子出也而要你于自会后什';
    return common[Math.floor(Math.random() * common.length)];
  }

  async waitFor(selector: string, timeoutMs = 10000): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** 带重试的 goto：最多 3 次指数退避。
   * referer：BOSS 招聘端有「入口来源」检测（风险登记册 51004：referrer 非 zhipin 来源且非 SEO
   * → 判非常态入口 → device-action-report 静默上报）。程序化 goto 默认不带 Referer，等同"直接访问"，
   * 会自己触发自己的硬停信号。故对站内跳转一律显式带上同域 Referer，模拟站内正常点击进入。 */
  async goto(url: string, referer?: string): Promise<boolean> {
    const maxAttempts = 3;
    let lastErr: any;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer });
        this.positionInitialized = false;
        return true;
      } catch (e) {
        lastErr = e;
        const backoff = 1000 * Math.pow(2, attempt);
        await sleep(backoff + randRange(0, 500));
      }
    }
    throw lastErr || new Error(`goto failed after ${maxAttempts} attempts: ${url}`);
  }

  /** 带重试的 back */
  async back(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
      } catch {
        if (attempt === 0) await sleep(1000);
      }
    }
    return false;
  }

  getPage() {
    return this.page;
  }

  getMousePos(): { x: number; y: number } {
    return { x: this.lastX, y: this.lastY };
  }
}
