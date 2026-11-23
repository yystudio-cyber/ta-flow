/**
 * JD 桥自检 —— 平台开着的时候跑，验证扩展真的能拿到能用的岗位数据。
 *
 * 覆盖三件事：
 *   1. 扩展 origin 拿得到数据，且 jdList 是【完整 JD】（只给 id/name/title 的话，
 *      扩展切岗位后会给所有候选人打出同一个默认分——照样出分但分是假的）
 *   2. 网页 origin（含 zhipin.com 本身）一律 403，别的网站读不走你的岗位
 *   3. 只吐岗位配置，不吐候选人数据
 *
 * 用法：先启动 TA 平台，再 npm run check:bridge
 */
import http from 'node:http';

const PORT = 17385;
const EXT_ID = 'hhjilkjdngolnidebdlmkkhpoidegbgc';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

function req(pathname, { origin, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: origin ? { Origin: origin } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    r.on('error', (e) => resolve({ error: String(e.message || e) }));
    r.setTimeout(4000, () => { r.destroy(); resolve({ error: 'timeout' }); });
    r.end();
  });
}

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra != null ? '  → ' + extra : ''}`);
};

const health = await req('/health');
if (health.error || health.status !== 200) {
  console.error(`✗ 连不上 http://127.0.0.1:${PORT}${health.error ? '（' + health.error + '）' : ''}`);
  console.error('  先启动 TA 平台再跑本脚本（平台启动时会自动起这个桥）。');
  process.exit(2);
}
check('/health 可达', true);

// 1. 扩展 origin
const ok = await req('/jd/active', { origin: EXT_ORIGIN });
check('扩展 origin 拿得到 /jd/active', ok.status === 200, `HTTP ${ok.status}`);
check('CORS 头只放行本扩展', ok.headers['access-control-allow-origin'] === EXT_ORIGIN, ok.headers['access-control-allow-origin']);

let payload = null;
try { payload = JSON.parse(ok.body); } catch { /* ignore */ }
check('返回是合法 JSON', !!payload);

if (payload) {
  const list = payload.jdList || [];
  check('岗位库非空', list.length > 0, `${list.length} 个岗位`);
  check('有激活岗位', !!payload.jd, payload.jd ? (payload.jd.name || payload.jd.title) : '（岗位库里一个都没激活 → 扩展会显示占位徽章）');
  check('阈值已下发', payload.thresholds && payload.thresholds.high != null, JSON.stringify(payload.thresholds));

  // 关键：jdList 必须是完整 JD
  const scorable = list.filter((j) => j && (j.basic || j.keywords));
  check('jdList 是完整 JD（带 basic/keywords，不是精简字段）',
    list.length === 0 || scorable.length === list.length,
    `${scorable.length}/${list.length} 个可评分`);
  if (list.length && scorable.length < list.length) {
    const bad = list.filter((j) => !(j && (j.basic || j.keywords))).map((j) => j.name || j.id);
    console.log(`    ↳ 这些岗位没填要求，扩展上会显示"无法评分"而不是假分：${bad.join('、')}`);
  }

  // PII 边界
  const raw = JSON.stringify(payload);
  const leaks = ['candidate', 'geek', 'resume', 'phone', 'wechat', '候选人', '简历', '手机号'].filter((k) => raw.includes(k));
  check('不含候选人数据', leaks.length === 0, leaks.length ? '疑似泄漏字段: ' + leaks.join(',') : '');
}

// 1b. BOSS 页面状态上报（工具库那两个按钮靠它区分「打开 BOSS」和「运行中」）
const withBoss = await req('/jd/active?bossAgo=3&cards=15', { origin: EXT_ORIGIN });
check('接受扩展捎带的 BOSS 状态参数', withBoss.status === 200, `HTTP ${withBoss.status}`);
const badQuery = await req('/jd/active?bossAgo=abc&cards=xyz', { origin: EXT_ORIGIN });
check('query 写坏了也不影响取岗位', badQuery.status === 200, `HTTP ${badQuery.status}`);

// 2. 非白名单 origin 必须 403
for (const bad of ['https://www.zhipin.com', 'https://evil.example.com', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
  const r = await req('/jd/active', { origin: bad });
  check(`拒绝 ${bad}`, r.status === 403, `HTTP ${r.status}`);
}

// 3. 预检
const pre = await req('/jd/active', { origin: EXT_ORIGIN, method: 'OPTIONS' });
check('扩展预检通过', pre.status === 204, `HTTP ${pre.status}`);
const preBad = await req('/jd/active', { origin: 'https://www.zhipin.com', method: 'OPTIONS' });
check('网页预检被拒', preBad.status === 403, `HTTP ${preBad.status}`);

// 4. 只读
const post = await req('/jd/active', { origin: EXT_ORIGIN, method: 'POST' });
check('拒绝非 GET', post.status === 405 || post.status === 403, `HTTP ${post.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : '✗ 失败 ' + failed.length + ' 项'}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
