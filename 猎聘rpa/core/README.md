# Liepin RPA

## What it does
- 搜索猎聘候选人并抓取简历基础信息
- 支持关键词、城市、行业、经验、学历筛选
- 支持 `json/csv` 输出
- 支持定时任务
- 支持消息触达，但默认关闭，且有 dry-run / 去重 / 发送上限保护

## Main files
- `liepin_rpa_enhanced.py`: 主程序（唯一推荐入口）
- `liepin_rpa.py`: 兼容入口（转发到 enhanced）
- `config.yaml`: 配置
- `start.bat`: 启动器
- `requirements.txt`: 依赖

## Quick start
```bash
pip install -r requirements.txt
python liepin_rpa_enhanced.py --test
```

或双击 `start.bat`。

## Runtime modes
- 默认模式：只采集，不发送消息（安全）
- `--test`：单关键词 + 单页，便于验证
- `--schedule`：按 `config.yaml` 中 `schedule.time` 定时运行
- `--send`：启用真实发送（会覆盖 dry-run）

## Safety controls
- 默认 `messaging.enabled=false`
- 默认 `messaging.dry_run=true`
- `skip_contacted=true` 防重复触达
- `global_limit/per_search_limit` 控制触达上限
- 联系状态记录在 `output/run_state.json`

## Important notes
- 首次运行需手动登录猎聘，登录后会保存 cookies
- `strict_filters=true` 时，筛选项如果未真正生效会直接失败，避免“假筛选”
- 如果页面结构变化导致选择器失效，可先用 `--test` 验证并更新选择器
