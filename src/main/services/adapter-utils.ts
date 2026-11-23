// Adapter 实现侧的共用小工具。
//
// ⚠️ 本文件【不得】import platform-adapter —— 它存在的唯一理由就是打断
//    platform-adapter ↔ adapters 的循环依赖。
//
// 历史教训（第二轮审查发现的 P0）：
//   原先这些函数放在 platform-adapter.ts 里，adapters 又要 import 它们 → 形成循环；
//   当时为了绕开循环，注册表改用了懒加载 `require('./adapters/boss')`。
//   结果 rollup 打包主进程时把这个动态 require 当成外部依赖直接丢弃 ——
//   打包产物里【一行 adapter 代码都没有】，启动即 "Cannot find module './adapters/boss'"，
//   两个平台同时废掉。而且开发态 (vite dev) 不复现，只有打包版才炸。
//   → 正确做法是从源头消除循环，让注册表用静态 import；并加 check:bundle 断言防回归。
import type { Page } from 'puppeteer-core';
import type { HumanOperator } from '../cdp/human-ops';
import type { ProbeSelectorHit } from '../../shared/types';

/** 按选择器列表依次尝试拟人点击，命中即返回 */
export async function humanClickSelectors(
  page: Page, op: HumanOperator, selectors: string[],
): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      try {
        return await op.clickElement(el);
      } catch {
        try { await el.click(); return true; } catch { /* continue */ }
      }
    }
  }
  return false;
}

/**
 * 合并用户在 settings 里粘贴的覆盖 JSON（真实账号校准后填入），失败/非法则用默认。
 * nestedKeys 指定需要逐层浅合并的子对象（否则用户只覆盖一个子键会把整组默认值冲掉）。
 */
export function mergeSelectorOverride<T extends Record<string, any>>(
  base: T, raw: string | undefined, nestedKeys: (keyof T)[],
): T {
  try {
    if (!raw || typeof raw !== 'string') return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return base;
    const out: any = { ...base, ...o };
    for (const k of nestedKeys) {
      out[k as string] = { ...(base[k] as any), ...((o as any)[k] || {}) };
    }
    return out as T;
  } catch {
    return base;
  }
}

/**
 * 清空输入框 —— 对 React / ant-design 受控组件安全的做法。
 *
 * 直接 `node.value = ''` 不会触发 React 的 onChange，React 内部 state 仍持有旧值；
 * 一旦组件因任何原因重渲染就会把旧文本恢复回来（表现为"搜了上一个关键词"）。
 * 用真实的 Ctrl+A → Delete 按键，既是真人操作，也让框架正常收到变更事件。
 */
export async function clearInputHumanly(page: Page, el: any): Promise<void> {
  try {
    await el.click();
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 100));
    await page.keyboard.press('Delete');
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
  } catch { /* 清空失败不阻断，后续 typeChatMessage 自身也会清一次 */ }
}

// ── 真机探针公共工具（放这里同样是为了不制造 platform-adapter ↔ adapters 的循环）──

/** 把一组选择器在页面上数一遍。count = -1 表示选择器语法非法/查询抛错。 */
export async function countSelectors(
  page: Page,
  defs: Array<{ name: string; selector: string; critical?: boolean }>,
): Promise<ProbeSelectorHit[]> {
  const out: ProbeSelectorHit[] = [];
  for (const d of defs) {
    let count = -1;
    try {
      count = await page.evaluate((sel: string) => {
        try { return document.querySelectorAll(sel).length; } catch { return -1; }
      }, d.selector);
    } catch { count = -1; }
    out.push({ name: d.name, selector: d.selector, count, critical: !!d.critical });
  }
  return out;
}

/** 姓名脱敏 —— 探针输出会进日志/被截图，绝不留全名（R2 合规） */
export function maskName(n?: string): string {
  if (!n) return '（无）';
  if (n.length <= 1) return n;
  return n[0] + '**';
}
