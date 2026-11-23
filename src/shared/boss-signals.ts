// BOSS 平台信号的纯判据（无任何依赖，可直接被测试台加载）。
//
// 单独成文件的原因：这两条判据一旦误报，就会触发 20 分钟熔断、直接打断正在跑的找人，
// 是全项目唯一"新增的会主动停机"的逻辑，必须能被断言覆盖（见 scripts/risk-lab.mjs）。
// 它们本身是纯函数，放在 cdp/chrome.ts 里会连带把 electron/sqlite/工具管理器整条
// 依赖链拖进测试，得不偿失。

// 「异常空数据」只对【出人的列表接口】判定：推荐牛人 / 职位搜索。
// 别的接口（聊天、职位管理、埋点）返空是完全正常的，纳进来必然误报。
const RECOMMEND_LIST_API = /\/wapi\/(zprelation\/friend\/getRecommendFriends|zpgeek\/search\/joblist)/i;

export function isRecommendListApi(url: string): boolean {
  return RECOMMEND_LIST_API.test(url);
}

/**
 * 登记册「异常空数据」判据：接口 200 + code 0，但 zpData 是空对象/空数组。
 *
 * 口径是【宁可漏报，绝不误报】——漏报只是少一次预警（DOM 层还有"连续 3 屏无人"兜底），
 * 误报却是无端停机 20 分钟。故：BOSS 的 zpData 形态不完全统一，认识的形态才判空，
 * 不认识的一律当作"有数据"。
 */
export function isEmptyZpData(z: any): boolean {
  if (z == null) return true;
  if (Array.isArray(z)) return z.length === 0;
  if (typeof z !== 'object') return false;
  const keys = Object.keys(z);
  if (keys.length === 0) return true;
  for (const f of ['geekList', 'list', 'items', 'data']) {
    if (Array.isArray((z as any)[f])) return (z as any)[f].length === 0;
  }
  return false;
}
