# Zhilian RPA

智联候选人采集器，默认用于人工筛选后的低风险候选人采集、审计留痕、恢复运行，并输出可导入 Recruiting Intelligence OS 的候选人数据。

## 默认运行

推荐默认保持：

- `navigation_mode: manual_page`
- `open_profile_link: false`
- 不自动发送沟通消息

安装依赖：

```bash
pip install -r requirements.txt
```

测试运行：

```bash
python zhilian_rpa_enhanced.py --config config.yaml --test
```

Probe 选择器：

```bash
python zhilian_rpa_enhanced.py --config config.yaml --probe
```

## 运行目录

每次运行都会生成一个 `run_id`：

```text
zhilian_YYYYMMDD_HHMMSS_xxxxxx
```

主输出目录：

```text
output/runs/<run_id>/
```

本轮 JSON、CSV、Word、debug HTML、evidence、`review_queue.csv`、`run_manifest.json` 都写入该目录。为了兼容旧流程，关键输出也会复制一份到 `output/` 根目录。

## run_manifest.json

每次运行结束都会写入：

```text
output/runs/<run_id>/run_manifest.json
```

字段包括：

- `run_id`
- `started_at`
- `ended_at`
- `mode`
- `keywords`
- `locations`
- `companies`
- `config_path`
- `config_hash`
- `total_cards_seen`
- `exported_count`
- `skipped_low_score_count`
- `skipped_seen_count`
- `skipped_company_mismatch_count`
- `detail_open_count`
- `risk_stopped`
- `risk_reason`
- `output_files`
- `word_report_path`
- `candidate_json_path`
- `candidate_csv_path`

如果未登录、选择器失效、出现安全验证或运行异常，manifest 仍会生成，用来说明失败原因和已产出的文件。

## Candidate Schema

候选人 JSON 会保留旧的扁平字段，同时新增标准结构：

- `source`
- `source_candidate_id`
- `source_profile_url`
- `source_run_id`
- `source_query`
- `identity`
- `profile`
- `matching`
- `dedupe`
- `audit`

`dedupe.fingerprint` 同步写入 legacy `unique_key`，用于跨运行去重。`audit.evidence_hash` 对应 `output/runs/<run_id>/evidence/` 下的证据文件。

## review_queue.csv

每次运行会额外输出：

```text
output/runs/<run_id>/review_queue.csv
```

字段：

```text
rank,name,current_company,current_title,location,experience,education,score,reasons,profile_url,recommended_action
```

`recommended_action` 规则：

- `score >= 60`: `人工查看`
- `35 <= score < 60`: `暂缓`
- `score < 35`: `排除`
- `dedupe_level` 为 `weak`: `可能重复`

该文件只用于人工复核，不会触发自动沟通。

## Probe Report

当候选人卡片抓不到、字段为空、页面结构变化时，先运行：

```bash
python zhilian_rpa_enhanced.py --config config.yaml --probe
```

除了终端输出，程序会生成：

```text
output/runs/<run_id>/debug/probe_selector_report_*.json
```

每个 selector 包含：

- `selector`
- `count`
- `sample_texts`
- `visible_count`
- `looks_candidate_count`

根据该 report 更新 `config.yaml` 里的 selector。

## 风险停止

检测到以下情况会 hard-stop，不刷新、不重试、不绕过：

- 验证码
- 安全验证
- 访问频繁
- 操作过快
- 账号异常
- 登录页跳转

停止后仍会保存已采集候选人、debug HTML、manifest 和队列文件。

## 明确禁止

本项目禁止加入：

- 验证码识别或验证码绕过
- 代理池
- webdriver 伪装
- 多账号轮换
- 自动沟通消息

## 配置校验

启动时会校验：

- `max_candidates_per_run` 必须在 `1-100`
- `max_pages` 必须在 `1-20`
- `min_score_to_open_detail` 不得小于 `min_score_to_export`
- action/page delay 的最小最大值顺序必须合法
- `output.save_path`、`debug_path`、`state_file` 所在目录必须可创建

配置非法会打印明确错误并退出。
