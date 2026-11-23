#!/usr/bin/env bash
# 猎聘 RPA 自动守候 + 满负荷跑通（VPN 窗口期专用）
#
# 背景：承鹏关 VPN 后猎聘才通，但关了 VPN 我（Claude）就掉线，没法实时操作。
# 所以本脚本在后台自己盯：一旦猎聘不再被境外 IP 拦截，立刻把页面重置到 /search、
# 置顶窗口、启动 RPA 跑满设定时长，全程日志落盘，等 VPN 开回来我直接读日志。
#
# 用法：bash scripts/liepin-autorun.sh [跑多少秒=480]
set -u
cd "$(dirname "$0")/.."
RUN_SECONDS="${1:-480}"
LOG="/tmp/liepin-autorun.log"
: > "$LOG"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "守候启动。等待猎聘可用（每 10 秒探一次，最多等 40 分钟）…"

cat > scripts/_probe-autorun.mjs <<'PROBE'
import puppeteer from 'puppeteer-core';
try {
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 15000 });
  const ps = await b.pages();
  const p = ps.find(x => /lpt\.liepin\.com/.test(x.url())) || ps[0];
  // 探针绝不导航（会重置 RPA 脚下的页面）
  await new Promise(r => setTimeout(r, 6000));
  const st = await p.evaluate(() => ({
    u: location.href,
    intercept: /intercept-abroad-ip|secure\/intercept/.test(location.pathname),
    login: /\/login/.test(location.pathname),
    kw: !!document.querySelector("input[placeholder^='搜职位']"),
  }));
  if (st.intercept) { console.log('BLOCKED'); }
  else if (st.login) { console.log('LOGIN'); }
  else { await p.bringToFront(); console.log("READY" + (st.kw ? "" : " (kw-late)")); }
  
  await b.disconnect();
} catch (e) { console.log('NOPORT ' + String(e.message || e).slice(0, 60)); }
PROBE

TRIES=0
while [ $TRIES -lt 240 ]; do
  R=$(node scripts/_probe-autorun.mjs 2>/dev/null | tail -1)
  case "$R" in
    READY*)
      say "✅ 猎聘可用，立刻开跑（$RUN_SECONDS 秒）"
      break ;;
    BLOCKED)
      [ $((TRIES % 6)) -eq 0 ] && say "…仍被境外 IP 拦截（请关闭 VPN）" ;;
    LOGIN)
      [ $((TRIES % 6)) -eq 0 ] && say "…停在登录页，请在 9333 那个窗口登录猎聘" ;;
    NOPORT*)
      [ $((TRIES % 6)) -eq 0 ] && say "…9333 端口不通（$R）" ;;
    *)
      [ $((TRIES % 6)) -eq 0 ] && say "…状态未知：$R" ;;
  esac
  TRIES=$((TRIES + 1))
  sleep 10
done

case "$R" in READY*) ;; *)
  say "✗ 等待超时，未等到可用窗口。"
  exit 1 ;; esac

say "▶ 启动 RPA …"
npx electron scripts/rpa-dryrun.js "$RUN_SECONDS" >> "$LOG" 2>&1
say "◀ RPA 结束（退出码 $?）"

say "=== 结果摘要 ==="
grep -E "组合|本屏|翻页|最后一页|统计|liepin_talents|daily_stats|error|warn" "$LOG" | tail -30 | tee -a "$LOG"
say "完整日志：$LOG"
