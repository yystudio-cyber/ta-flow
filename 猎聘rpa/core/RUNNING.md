# 猎聘 RPA Claude Code 运行说明

这个包只包含 RPA 代码、配置和运行脚本，不包含 `liepin_cookies.json`、候选人数据、截图、Word 报告等敏感或产出文件。

## 1. 安装环境

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

如在 macOS/Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. 首次登录

首次运行会打开 Chrome 登录猎聘招聘端。请手动登录，脚本会自动保存 cookies 到 `liepin_cookies.json`。

该文件包含登录态，不建议提交到 Git 或发给别人。

## 3. 常用命令

基础测试：

```powershell
python liepin_rpa_enhanced.py --config config.yaml --test --lenient-filters
```

示例岗位搜索：

```powershell
python liepin_rpa_enhanced.py --config config_ai_cockpit_20260427.yaml --lenient-filters
python liepin_rpa_enhanced.py --config config_ai_cockpit_targets_20260427.yaml --lenient-filters
```

五岗位批量搜索：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_role_searches_20260427.ps1
```

生成五岗位候选池与简历包的后续脚本：

```powershell
python role_candidate_pipeline.py shortlist
python fetch_role_candidate_details.py
python role_candidate_pipeline.py final
python build_role_resume_pack.py
```

## 4. 文件说明

- `liepin_rpa_enhanced.py`：主 RPA，负责登录、搜索、翻页、抓取候选人列表。
- `liepin_rpa.py`：兼容入口，转发到 enhanced 版本。
- `config*.yaml`：不同岗位/任务的搜索配置。
- `run_role_searches_20260427.ps1`：批量运行四类角色的搜索。
- `role_candidate_pipeline.py`：按岗位 JD 打分、去重、入围。
- `fetch_role_candidate_details.py`：抓取入围候选人的猎聘详情页文本。
- `build_role_resume_pack.py`：生成五岗位候选人简历包 Word。
- `analyze_run.py` / `fetch_details.py` / `build_report.py`：单个岗位的专项分析链路。

## 5. 注意事项

- 默认只采集，不发送消息。不要使用 `--send`，除非明确要真实触达候选人。
- `output/` 是运行产物目录，首次运行会自动创建。
- 如果猎聘页面结构变化，优先检查 `liepin_rpa_enhanced.py` 里的选择器和 `_safe_profile_url`。
