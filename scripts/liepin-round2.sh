#!/usr/bin/env bash
# 第一轮跑完 → 自动应用旧版口径的扩展配置 → 立刻开第二轮。
# 全程无人值守：承鹏关着 VPN 时 Claude 掉线也照跑。
set -u
cd "$(dirname "$0")/.."
R1_LOG="/tmp/rpa-v2.log"
R2_LOG="/tmp/rpa-round2.log"
CHAIN="/tmp/liepin-round2-chain.log"
: > "$CHAIN"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$CHAIN"; }

say "等第一轮收工（盯 $R1_LOG 的「落库结果」）…"
W=0
while [ $W -lt 400 ]; do
  if grep -q "落库结果" "$R1_LOG" 2>/dev/null; then break; fi
  W=$((W+1)); sleep 10
done
if ! grep -q "落库结果" "$R1_LOG" 2>/dev/null; then
  say "✗ 等超时，第一轮未收工，不启动第二轮"; exit 1
fi
say "✅ 第一轮已收工。摘要："
grep -E "统计:|liepin_talents 条数|daily_stats" "$R1_LOG" | tail -3 | tee -a "$CHAIN"

say "▶ 应用旧版口径扩展配置（18 组合 / 全国 / 26 目标公司）…"
npx electron scripts/seed-liepin-task-expanded.js 2>&1 | grep -E "__R__|error" | tee -a "$CHAIN"

say "▶ 第二轮开跑（2400 秒）…"
npx electron scripts/rpa-dryrun.js 2400 > "$R2_LOG" 2>&1
say "◀ 第二轮结束（退出码 $?）"
grep -E "搜索组合|统计:|liepin_talents 条数|daily_stats|载荷不可读" "$R2_LOG" | tail -12 | tee -a "$CHAIN"
say "第二轮完整日志：$R2_LOG"
