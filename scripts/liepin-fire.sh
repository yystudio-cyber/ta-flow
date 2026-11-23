#!/usr/bin/env bash
# 猎聘 RPA「等你就位就开炮」——一小时无人值守长跑。
#
# 用法：bash scripts/liepin-fire.sh [秒数=3600]
#
# 你要做的：关 VPN → 在 9333 那个窗口登录猎聘 → 停在搜索界面。就这样，别的不用管。
# 脚本每 8 秒探一次，识别到【已登录 + 在搜索页 + 搜索框已渲染】就立刻开跑，
# 跑满设定时长后自动收尾并打印结果摘要。
#
# 三条来自真机的硬纪律，写死在这里：
#   ① 探针【绝不导航】。早先版本每 10 秒 goto('/search') 一次，把 RPA 脚下的页面
#      反复重置，导致误报「搜索框未就绪」——那是自伤，不是平台问题。
#   ② 开跑前杀掉所有同类残留进程，避免两个实例互相抢页面。
#   ③ 连续三次探到"就位"才开跑，防止你正在登录的中间态被误判成已就绪。
set -u
cd "$(dirname "$0")/.."
RUN_SECONDS="${1:-3600}"
LOG="/tmp/liepin-fire.log"
: > "$LOG"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ② 清场：杀掉可能残留的守候/运行实例（不碰浏览器）
pkill -f "liepin-autorun" 2>/dev/null || true
pkill -f "liepin-round2" 2>/dev/null || true
pkill -f "rpa-dryrun" 2>/dev/null || true
sleep 1

cat > scripts/_probe-fire.mjs <<'PROBE'
import puppeteer from 'puppeteer-core';
try {
  const b = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 12000,
  });
  const ps = await b.pages();
  const p = ps.find((x) => /lpt\.liepin\.com/.test(x.url())) || ps[0];
  // ① 只读，绝不 goto
  const st = await p.evaluate(() => ({
    path: location.pathname,
    intercept: /intercept-abroad-ip|secure\/intercept/.test(location.pathname),
    login: /\/login/.test(location.pathname)
      || /请先登录|扫码登录|账号登录|手机号登录/.test(document.body?.innerText || ''),
    kw: !!document.querySelector("input[placeholder^='搜职位']"),
    onSearch: /\/search/.test(location.pathname),
  }));
  if (st.intercept) console.log('BLOCKED');
  else if (st.login) console.log('LOGIN');
  else if (st.onSearch && st.kw) { await p.bringToFront(); console.log('READY'); }
  else console.log('NOTSEARCH ' + st.path.slice(0, 40));
  await b.disconnect();
} catch (e) { console.log('NOPORT ' + String(e.message || e).slice(0, 50)); }
PROBE

say "待命中。请：① 关 VPN ② 在 9333 窗口登录猎聘 ③ 停在搜索界面"
say "（识别到就位后自动开跑 ${RUN_SECONDS} 秒；每 8 秒探一次，最多等 60 分钟）"

HITS=0; TRIES=0; LAST=""
while [ $TRIES -lt 450 ]; do
  R=$(node scripts/_probe-fire.mjs 2>/dev/null | tail -1)
  case "$R" in
    READY)
      HITS=$((HITS+1))
      say "就位信号 ${HITS}/3"
      # ③ 连中三次才开跑，避开登录中间态
      if [ $HITS -ge 3 ]; then break; fi ;;
    *)
      HITS=0
      if [ "$R" != "$LAST" ]; then
        case "$R" in
          BLOCKED)  say "…被境外 IP 拦截，请关闭 VPN" ;;
          LOGIN)    say "…在登录页，请登录猎聘" ;;
          NOTSEARCH*) say "…已登录但不在搜索页（$R），请进 lpt.liepin.com/search" ;;
          NOPORT*)  say "…9333 端口不通，请用平台「打开猎聘浏览器」重开窗口" ;;
          *)        say "…状态：$R" ;;
        esac
        LAST="$R"
      fi ;;
  esac
  TRIES=$((TRIES+1)); sleep 8
done

if [ $HITS -lt 3 ]; then say "✗ 等待超时，未等到就位。"; exit 1; fi

say "🔥 已就位，开跑 ${RUN_SECONDS} 秒（约 $((RUN_SECONDS/60)) 分钟）"
npx electron scripts/rpa-dryrun.js "$RUN_SECONDS" >> "$LOG" 2>&1
say "◀ 运行结束（退出码 $?）"

say "════════ 结果摘要 ════════"
grep -E "▶ 搜索组合|本屏发现|统计:|liepin_talents 条数|daily_stats|风控信号|error" "$LOG" | tail -30 | tee -a "$LOG"
say "完整日志：$LOG"
