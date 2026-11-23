import argparse
import csv
import hashlib
import json
import os
import random
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote_plus, urljoin
from uuid import uuid4

import schedule
import yaml
from selenium import webdriver
from selenium.common.exceptions import (
    StaleElementReferenceException,
    WebDriverException,
)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _deep_merge(base, incoming):
    if not isinstance(incoming, dict):
        return base
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _normalize_space(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _truncate(value, limit=1500):
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _normalize_for_match(value):
    text = _normalize_space(value).lower()
    text = re.sub(r"[\s,，.。:：;；\-_/\\|()（）\[\]【】]+", "", text)
    for suffix in [
        "有限公司",
        "有限责任公司",
        "股份有限公司",
        "科技",
        "集团",
        "公司",
        "inc",
        "ltd",
        "limited",
        "co",
    ]:
        text = text.replace(suffix, "")
    return text


def _iter_terms(items):
    for item in _as_list(items):
        if isinstance(item, dict):
            for key in ["name", "value", "term"]:
                if item.get(key):
                    yield str(item[key])
            for alias in _as_list(item.get("aliases")):
                if alias:
                    yield str(alias)
        elif item:
            yield str(item)


def _sha256_text(value):
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _json_default(value):
    if isinstance(value, Path):
        return str(value)
    return str(value)


class ZhilianRPA:
    def __init__(
        self,
        config_path="config.yaml",
        test_mode=False,
        probe_mode=False,
        keyword_override=None,
        location_override=None,
        company_override=None,
        navigation_mode_override=None,
        entry_url_override=None,
    ):
        self.driver = None
        self.wait = None
        self.config_path = os.path.abspath(config_path)
        self.base_dir = os.path.dirname(self.config_path)
        self.test_mode = test_mode
        self.probe_mode = probe_mode
        self.keyword_override = keyword_override
        self.location_override = location_override
        self.company_override = company_override
        self.navigation_mode_override = navigation_mode_override
        self.entry_url_override = entry_url_override

        raw = self.load_config(self.config_path)
        self.config = self.normalize_config(raw)
        if self.navigation_mode_override:
            self.config["search"]["navigation_mode"] = self.navigation_mode_override
        if self.entry_url_override is not None:
            self.config["search"]["entry_url"] = self.entry_url_override

        self.validate_config()

        login_cfg = self.config.get("login", {})
        output_cfg = self.config.get("output", {})
        self.run_id = f"zhilian_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:6]}"
        self.started_at = datetime.now()
        self.mode = "probe" if self.probe_mode else ("test" if self.test_mode else "run")
        self.config_hash = self.compute_config_hash()
        self.cookies_file = self.resolve_path(login_cfg.get("cookies_file", "zhilian_cookies.json"))
        self.output_dir = self.resolve_path(output_cfg.get("save_path", "./output"))
        self.state_file = self.resolve_path(output_cfg.get("state_file", "./output/run_state.json"))
        self.legacy_debug_dir = self.resolve_path(output_cfg.get("debug_path", "./output/debug"))
        self.run_dir = os.path.join(self.output_dir, "runs", self.run_id)
        self.debug_dir = os.path.join(self.run_dir, "debug")
        self.evidence_dir = os.path.join(self.run_dir, "evidence")
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.run_dir, exist_ok=True)
        os.makedirs(self.debug_dir, exist_ok=True)
        os.makedirs(self.evidence_dir, exist_ok=True)
        self.profile_opens_this_run = 0
        self.detail_open_count = 0
        self.candidates_saved_this_run = 0
        self.last_word_report_path = ""
        self.last_json_path = ""
        self.last_csv_path = ""
        self.last_review_queue_path = ""
        self.output_files = []
        self.total_cards_seen = 0
        self.exported_count = 0
        self.skipped_low_score_count = 0
        self.skipped_seen_count = 0
        self.skipped_company_mismatch_count = 0
        self.risk_stopped = False
        self.risk_reason = ""

        self.state = self.load_state()
        self.loaded_history_count = len(self.state.get("history", []))
        self.processed_keys = set(self.state.get("processed_candidate_keys", []))

    def resolve_path(self, path_value):
        if os.path.isabs(path_value):
            return os.path.normpath(path_value)
        return os.path.normpath(os.path.join(self.base_dir, path_value))

    def compute_config_hash(self):
        try:
            with open(self.config_path, "rb") as handle:
                return hashlib.sha256(handle.read()).hexdigest()
        except FileNotFoundError:
            return ""

    def validate_config(self):
        errors = []
        search_cfg = self.config.get("search", {})
        safety_cfg = self.config.get("safety", {})
        output_cfg = self.config.get("output", {})

        max_candidates = _safe_int(search_cfg.get("max_candidates_per_run"), -1)
        if not 1 <= max_candidates <= 100:
            errors.append("search.max_candidates_per_run 必须在 1 到 100 之间")

        max_pages = _safe_int(search_cfg.get("max_pages"), -1)
        if not 1 <= max_pages <= 20:
            errors.append("search.max_pages 必须在 1 到 20 之间")

        min_export = _safe_int(search_cfg.get("min_score_to_export"), 0)
        min_detail = _safe_int(search_cfg.get("min_score_to_open_detail"), 0)
        if min_detail < min_export:
            errors.append("search.min_score_to_open_detail 不得小于 min_score_to_export")

        for low_key, high_key in [
            ("min_action_delay", "max_action_delay"),
            ("min_page_delay", "max_page_delay"),
        ]:
            try:
                low = float(safety_cfg.get(low_key))
                high = float(safety_cfg.get(high_key))
                if low < 0 or high < 0 or high < low:
                    errors.append(f"safety.{low_key}/safety.{high_key} 顺序必须合法且不能为负数")
            except (TypeError, ValueError):
                errors.append(f"safety.{low_key}/safety.{high_key} 必须是数字")

        for key in ["save_path", "debug_path"]:
            path_value = output_cfg.get(key, "")
            if not path_value:
                errors.append(f"output.{key} 不能为空")
                continue
            try:
                os.makedirs(self.resolve_path(path_value), exist_ok=True)
            except OSError as exc:
                errors.append(f"output.{key} 不可创建: {path_value} ({exc})")

        state_file = output_cfg.get("state_file", "")
        if not state_file:
            errors.append("output.state_file 不能为空")
        else:
            try:
                os.makedirs(os.path.dirname(self.resolve_path(state_file)), exist_ok=True)
            except OSError as exc:
                errors.append(f"output.state_file 所在目录不可创建: {state_file} ({exc})")

        if errors:
            for error in errors:
                print(f"[CONFIG ERROR] {error}")
            raise SystemExit(2)

    def load_config(self, config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                data = yaml.safe_load(handle)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception as exc:
            print(f"[WARN] 配置读取失败，改用默认配置: {exc}")
            return {}

    def normalize_config(self, raw):
        defaults = {
            "login": {
                "manual_login": True,
                "manual_login_wait_seconds": 300,
                "use_saved_cookies": True,
                "login_url": "https://passport.zhaopin.com/org/login",
                "home_url": "https://rd6.zhaopin.com/",
                "cookies_file": "zhilian_cookies.json",
            },
            "search": {
                "navigation_mode": "manual_page",
                "entry_url": "https://rd6.zhaopin.com/",
                "direct_url_template": "",
                "manual_page_wait_seconds": 300,
                "keywords": ["后端开发"],
                "locations": ["上海"],
                "companies": [""],
                "max_pages": 2,
                "max_candidates_per_run": 20,
                "min_score_to_export": 15,
                "min_score_to_open_detail": 35,
                "strict_mode": False,
                "open_detail_panel": False,
                "open_profile_link": False,
                "skip_seen_candidates": True,
                "require_query_company_match": True,
                "page_load_timeout": 12,
                "selectors": {
                    "keyword_input": [
                        "input[placeholder*='关键词']",
                        "input[placeholder*='搜索']",
                        "input[placeholder*='候选人']",
                        "input[type='search']",
                    ],
                    "location_input": [
                        "input[placeholder*='城市']",
                        "input[placeholder*='地点']",
                        "input[placeholder*='地区']",
                    ],
                    "company_input": [
                        "input[placeholder*='公司']",
                        "input[placeholder*='企业']",
                    ],
                    "search_button": [
                        "button[type='submit']",
                        "button[class*='search']",
                        "button[class*='Search']",
                    ],
                    "list_card": [
                        "[data-resume-id]",
                        "[data-candidate-id]",
                        "[data-id]",
                        "[class*='resumeCard']",
                        "[class*='resume-card']",
                        "[class*='candidateCard']",
                        "[class*='candidate-card']",
                        "[class*='resumeList'] [class*='item']",
                        "[class*='candidateList'] [class*='item']",
                        "[class*='list-item']",
                        ".resume-card",
                        ".candidate-card",
                    ],
                    "next_button": [
                        "button[aria-label*='下一']",
                        "a[aria-label*='下一']",
                        "button[class*='next']",
                        "a[class*='next']",
                        ".pagination-next",
                    ],
                    "candidate_link": [
                        "a[href*='resume']",
                        "a[href*='candidate']",
                        "a[href*='detail']",
                        "a[target='_blank']",
                        "a",
                    ],
                    "detail_panel": [
                        "[class*='resumeDetail']",
                        "[class*='resume-detail']",
                        "[class*='candidateDetail']",
                        "[class*='candidate-detail']",
                        "[class*='detailPanel']",
                        "[class*='detail-panel']",
                        "main",
                    ],
                    "name": ["[class*='name']", ".name", "strong", "b"],
                    "title": ["[class*='title']", "[class*='job']", ".title"],
                    "company": ["[class*='company']", ".company"],
                    "education": ["[class*='education']", "[class*='edu']"],
                    "experience": ["[class*='experience']", "[class*='workYear']", "[class*='work-year']"],
                    "location": ["[class*='location']", "[class*='city']", ".location"],
                },
            },
            "profile": {
                "target_names": [],
                "target_keywords": [
                    "后端开发",
                    "分布式系统",
                    "无人驾驶",
                    "出行运营",
                    "运营负责人",
                    "运营专家",
                    "运营总监",
                    "增长负责人",
                ],
                "target_companies": [
                    "示例科技",
                    "示例科技C",
                    "示例科技D",
                    "示例科技E",
                    "示例科技F",
                    "曹操",
                    "示例科技G",
                    "示例科技H",
                    "文远",
                    "元戎",
                ],
                "target_titles": ["运营负责人", "运营总监", "城市经理", "增长负责人", "专家", "leader", "head"],
                "negative_keywords": ["实习", "应届", "兼职", "销售顾问", "客服"],
                "seniority_keywords": ["负责人", "总监", "leader", "head", "专家", "高级", "一号位"],
                "preferred_education": ["本科", "硕士", "博士"],
                "score_weights": {
                    "target_name": 45,
                    "target_company": 30,
                    "target_title": 16,
                    "target_keyword": 10,
                    "query_keyword": 8,
                    "seniority": 12,
                    "education": 6,
                    "experience_8_years": 12,
                    "experience_5_years": 8,
                    "profile_link": 4,
                    "negative_keyword": -25,
                },
            },
            "anti_detection": {"min_delay": 3.0, "max_delay": 7.0},
            "safety": {
                "min_action_delay": 3.0,
                "max_action_delay": 7.0,
                "min_page_delay": 8.0,
                "max_page_delay": 18.0,
                "pause_after_candidates": 5,
                "pause_seconds": 45,
                "max_profile_opens_per_run": 8,
                "stop_on_risk_checkpoint": True,
                "risk_stop_words": ["验证码", "安全验证", "访问频繁", "操作过快", "账号异常"],
            },
            "output": {
                "save_candidates": True,
                "save_path": "./output",
                "file_format": "json",
                "word_report": True,
                "word_report_limit": 50,
                "word_filename": "",
                "state_file": "./output/run_state.json",
                "fixed_filename": "",
                "debug_path": "./output/debug",
                "dump_debug_html": True,
            },
            "schedule": {"enabled": False, "time": "09:00"},
            "workflow": {"service": "screening", "default_no_message": True, "use_task_memory": True},
        }

        cfg = _deep_merge(defaults, raw if isinstance(raw, dict) else {})
        legacy = raw if isinstance(raw, dict) else {}
        if isinstance(legacy.get("keyword"), str):
            cfg["search"]["keywords"] = [legacy["keyword"]]
        if isinstance(legacy.get("city"), str):
            cfg["search"]["locations"] = [legacy["city"]]
        if isinstance(legacy.get("companies"), list):
            cfg["search"]["companies"] = legacy["companies"]
        if isinstance(legacy.get("max_pages"), int):
            cfg["search"]["max_pages"] = legacy["max_pages"]
        if isinstance(legacy.get("max_resumes_per_run"), int):
            cfg["search"]["max_candidates_per_run"] = legacy["max_resumes_per_run"]
        if isinstance(legacy.get("output_dir"), str):
            cfg["output"]["save_path"] = legacy["output_dir"]
        if isinstance(legacy.get("schedule_time"), str):
            cfg["schedule"]["time"] = legacy["schedule_time"]
        if isinstance(legacy.get("anti_detection"), dict) and "safety" not in legacy:
            anti_cfg = legacy["anti_detection"]
            if "min_delay" in anti_cfg:
                cfg["safety"]["min_action_delay"] = anti_cfg["min_delay"]
            if "max_delay" in anti_cfg:
                cfg["safety"]["max_action_delay"] = anti_cfg["max_delay"]

        if not cfg["search"]["keywords"]:
            cfg["search"]["keywords"] = [""]
        if not cfg["search"]["locations"]:
            cfg["search"]["locations"] = [""]
        if not cfg["search"]["companies"]:
            cfg["search"]["companies"] = [""]
        return cfg

    def load_state(self):
        if not os.path.exists(self.state_file):
            return {"processed_candidate_keys": [], "history": []}
        try:
            with open(self.state_file, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if not isinstance(data, dict):
                raise ValueError("run_state.json 根节点不是对象")
            data.setdefault("processed_candidate_keys", [])
            data.setdefault("history", [])
            return data
        except Exception as exc:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = f"{self.state_file}.corrupt.{timestamp}.json"
            try:
                shutil.copy2(self.state_file, backup_path)
                print(f"[WARN] run_state.json 损坏，已备份到 {backup_path}: {exc}")
            except OSError as backup_exc:
                print(f"[WARN] run_state.json 损坏且备份失败: {backup_exc}; 原错误: {exc}")
            return {"processed_candidate_keys": [], "history": []}

    def save_state(self):
        current = self.load_state()
        current_processed = set(current.get("processed_candidate_keys", []))
        current_processed.update(self.processed_keys)
        self.state["processed_candidate_keys"] = sorted(current_processed)
        pending_history = self.state.get("history", [])[self.loaded_history_count :]
        self.state["history"] = current.get("history", []) + pending_history
        self.loaded_history_count = len(self.state["history"])
        self.state["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
        tmp_path = f"{self.state_file}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(self.state, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.state_file)

    def find_cached_driver(self):
        env_path = os.environ.get("CHROMEDRIVER_PATH", "").strip()
        if env_path and os.path.exists(env_path):
            return env_path
        hits = []
        for base in [
            Path.home() / ".wdm" / "drivers" / "chromedriver" / "win64",
            Path.home() / ".wdm" / "drivers" / "chromedriver",
        ]:
            if not base.exists():
                continue
            hits.extend(base.rglob("chromedriver.exe"))
        if not hits:
            return ""
        hits.sort(key=lambda item: item.stat().st_mtime, reverse=True)
        return str(hits[0])

    def init_driver(self):
        chrome_options = Options()
        chrome_options.add_argument("--lang=zh-CN")
        chrome_options.add_experimental_option(
            "prefs",
            {
                "credentials_enable_service": False,
                "profile.password_manager_enabled": False,
            },
        )

        from selenium.webdriver.chrome.service import Service

        cached = self.find_cached_driver()
        if cached:
            self.driver = webdriver.Chrome(service=Service(cached), options=chrome_options)
        else:
            try:
                from webdriver_manager.chrome import ChromeDriverManager

                self.driver = webdriver.Chrome(
                    service=Service(ChromeDriverManager().install()),
                    options=chrome_options,
                )
            except Exception:
                self.driver = webdriver.Chrome(options=chrome_options)

        self.driver.set_window_size(1400, 920)
        self.wait = WebDriverWait(self.driver, 12)

    def random_delay(self, low=None, high=None):
        cfg = self.config.get("safety", {})
        legacy = self.config.get("anti_detection", {})
        floor_min = float(cfg.get("min_action_delay", legacy.get("min_delay", 3.0)))
        floor_max = float(cfg.get("max_action_delay", legacy.get("max_delay", 7.0)))
        min_delay = floor_min if low is None else max(float(low), floor_min)
        max_delay = floor_max if high is None else max(float(high), min_delay)
        time.sleep(random.uniform(min_delay, max_delay))

    def page_delay(self):
        cfg = self.config.get("safety", {})
        low = float(cfg.get("min_page_delay", 8.0))
        high = float(cfg.get("max_page_delay", 18.0))
        time.sleep(random.uniform(low, max(low, high)))

    def maybe_pause_after_candidate(self):
        cfg = self.config.get("safety", {})
        every = _safe_int(cfg.get("pause_after_candidates", 5), 5)
        pause_seconds = float(cfg.get("pause_seconds", 45))
        if every <= 0 or pause_seconds <= 0:
            return
        if self.candidates_saved_this_run and self.candidates_saved_this_run % every == 0:
            print(f"[INFO] 已保存 {self.candidates_saved_this_run} 人，暂停 {pause_seconds:.0f}s 降低操作频率")
            time.sleep(pause_seconds)

    def risk_checkpoint_detected(self):
        safety_cfg = self.config.get("safety", {})
        if not safety_cfg.get("stop_on_risk_checkpoint", True):
            return False
        body = self.page_text(limit=2000)
        current_url = self.driver.current_url if self.driver else ""
        markers = _as_list(safety_cfg.get("risk_stop_words"))
        hit_marker = next((marker for marker in markers if marker and marker in body), "")
        if hit_marker:
            self.risk_stopped = True
            self.risk_reason = f"risk_word:{hit_marker}"
            print("[WARN] 页面出现验证码/安全验证/访问频繁/账号异常等提示，本轮停止，建议人工检查账号状态")
            self.dump_debug_html("risk_checkpoint")
            return True
        if "passport.zhaopin.com" in (current_url or "").lower():
            self.risk_stopped = True
            self.risk_reason = "login_redirect"
            print("[WARN] 页面跳转到登录域名，本轮停止")
            self.dump_debug_html("login_checkpoint")
            return True
        return False

    def load_cookies(self):
        if not os.path.exists(self.cookies_file):
            return False
        try:
            with open(self.cookies_file, "r", encoding="utf-8") as handle:
                cookies = json.load(handle)
            self.driver.get(self.config["login"]["home_url"])
            allowed = {"name", "value", "path", "domain", "secure", "httpOnly", "expiry", "sameSite"}
            for cookie in cookies:
                clean = {key: value for key, value in cookie.items() if key in allowed}
                if "domain" not in clean:
                    clean["domain"] = ".zhaopin.com"
                if isinstance(clean.get("expiry"), float):
                    clean["expiry"] = int(clean["expiry"])
                try:
                    self.driver.add_cookie(clean)
                except WebDriverException:
                    continue
            return True
        except Exception as exc:
            print(f"[WARN] cookies 恢复失败: {exc}")
            return False

    def save_cookies(self):
        try:
            with open(self.cookies_file, "w", encoding="utf-8") as handle:
                json.dump(self.driver.get_cookies(), handle, ensure_ascii=False, indent=2)
        except Exception as exc:
            print(f"[WARN] cookies 保存失败: {exc}")

    def page_text(self, limit=None):
        try:
            text = self.driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            return ""
        text = _normalize_space(text)
        return _truncate(text, limit) if limit else text

    def detect_logged_in(self):
        current_url = (self.driver.current_url or "").lower()
        body = self.page_text(limit=1200)
        if "passport.zhaopin.com" in current_url and any(token in body for token in ["登录", "验证码", "扫码"]):
            return False
        markers = [
            "找人才",
            "人才推荐",
            "简历搜索",
            "简历管理",
            "候选人",
            "职位管理",
            "招聘管理",
            "人才选拔",
        ]
        if any(marker in body for marker in markers):
            return True
        return "rd6.zhaopin.com" in current_url or "rd5.zhaopin.com" in current_url

    def ensure_login(self):
        login_cfg = self.config.get("login", {})
        self.driver.get(login_cfg.get("login_url", "https://passport.zhaopin.com/org/login"))
        self.random_delay(1.0, 1.5)

        if login_cfg.get("use_saved_cookies", True) and self.load_cookies():
            self.driver.get(login_cfg.get("home_url", "https://rd6.zhaopin.com/"))
            self.random_delay(1.0, 1.5)
            if self.detect_logged_in():
                print("[INFO] 已通过 cookies 恢复智联登录态")
                return True
            print("[WARN] 已保存 cookies 未通过登录校验，需要手动登录")

        print("请在打开的浏览器里完成智联企业端登录。")
        print("建议登录后直接进入“找人才 / 简历搜索 / 人才推荐”页面。")
        wait_seconds = _safe_int(login_cfg.get("manual_login_wait_seconds", 300), 300)
        if (self.test_mode or self.probe_mode) and not (sys.stdin and sys.stdin.isatty()):
            wait_seconds = min(wait_seconds, 5)
        if sys.stdin and sys.stdin.isatty():
            try:
                input("登录完成后按 Enter 继续 > ")
            except EOFError:
                wait_seconds = min(wait_seconds, 5) if (self.test_mode or self.probe_mode) else wait_seconds
                print(f"[INFO] 未收到交互输入，等待登录检测 {wait_seconds} 秒...")
                deadline = time.time() + wait_seconds
                while time.time() < deadline:
                    if self.detect_logged_in():
                        break
                    time.sleep(1)
        else:
            print(f"[INFO] 当前为非交互终端，自动等待登录 {wait_seconds} 秒...")
            deadline = time.time() + wait_seconds
            while time.time() < deadline:
                if self.detect_logged_in():
                    break
                time.sleep(3)

        if self.detect_logged_in():
            self.save_cookies()
            print("[INFO] 登录态检测通过")
            return True
        print("[ERROR] 未检测到智联企业端登录态")
        return False

    def selector_cfg(self, key):
        return self.config.get("search", {}).get("selectors", {}).get(key, [])

    def locate_first(self, selectors, root=None, visible_only=True):
        container = root or self.driver
        for selector in selectors:
            try:
                nodes = container.find_elements(By.CSS_SELECTOR, selector)
            except Exception:
                continue
            for node in nodes:
                try:
                    if visible_only and not node.is_displayed():
                        continue
                    return node, selector
                except StaleElementReferenceException:
                    continue
        return None, ""

    def dismiss_overlays(self):
        for _ in range(3):
            close_button, _selector = self.locate_first(
                [
                    "button[aria-label='关闭']",
                    "button[aria-label*='close']",
                    "[class*='close']",
                    "[class*='Close']",
                    ".modal-close",
                    ".dialog-close",
                ]
            )
            if not close_button:
                return
            try:
                close_button.click()
                time.sleep(0.3)
            except Exception:
                return

    def set_input_value(self, selectors, value, label):
        if not value:
            return False
        element, selector = self.locate_first(selectors)
        if not element:
            print(f"[WARN] 未找到{label}输入框")
            return False
        try:
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
            element.click()
            time.sleep(0.2)
            element.send_keys(Keys.CONTROL, "a")
            element.send_keys(Keys.DELETE)
            try:
                element.clear()
            except Exception:
                pass
            element.send_keys(value)
            print(f"[INFO] 已写入{label}: {value} ({selector})")
            return True
        except Exception as exc:
            print(f"[WARN] {label}写入失败: {exc}")
            return False

    def click_first(self, selectors):
        button, selector = self.locate_first(selectors)
        if not button:
            return False
        try:
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", button)
            button.click()
        except Exception:
            try:
                self.driver.execute_script("arguments[0].click();", button)
            except Exception:
                return False
        print(f"[INFO] 已点击: {selector}")
        return True

    def find_cards(self, preferred_selector=""):
        selectors = [preferred_selector] if preferred_selector else []
        selectors.extend([item for item in self.selector_cfg("list_card") if item != preferred_selector])
        for selector in selectors:
            if not selector:
                continue
            try:
                nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
            except Exception:
                continue
            cards = [node for node in nodes if self.card_looks_candidate(node)]
            if cards:
                return cards, selector
        return [], ""

    def card_looks_candidate(self, node):
        try:
            text = _normalize_space(node.text)
        except Exception:
            return False
        if len(text) < 6:
            return False
        for attr in ["data-resume-id", "data-candidate-id", "data-id"]:
            try:
                if node.get_attribute(attr):
                    return True
            except Exception:
                continue
        return len(text.splitlines()) >= 2 or len(text.split()) >= 4

    def wait_for_cards(self):
        timeout = _safe_int(self.config.get("search", {}).get("page_load_timeout", 12), 12)
        deadline = time.time() + timeout
        while time.time() < deadline:
            cards, selector = self.find_cards()
            if cards:
                return cards, selector
            time.sleep(0.5)
        return [], ""

    def build_direct_url(self, keyword, location, company, page=1):
        template = self.config.get("search", {}).get("direct_url_template", "")
        if not template:
            return ""
        return template.format(
            keyword=quote_plus(keyword or ""),
            location=quote_plus(location or ""),
            company=quote_plus(company or ""),
            page=page,
            keyword_raw=keyword or "",
            location_raw=location or "",
            company_raw=company or "",
        )

    def wait_for_manual_page_ready(self, keyword, location, company):
        wait_seconds = _safe_int(self.config.get("search", {}).get("manual_page_wait_seconds", 300), 300)
        if (self.test_mode or self.probe_mode) and not (sys.stdin and sys.stdin.isatty()):
            wait_seconds = min(wait_seconds, 5)
        print("请在当前浏览器中打开智联企业端的候选人列表页。")
        print(f"建议筛选条件: 关键词={keyword or '-'} | 城市={location or '-'} | 公司={company or '-'}")
        if sys.stdin and sys.stdin.isatty():
            try:
                input("当页面上已经看到候选人列表后，按 Enter 开始抓取 > ")
            except EOFError:
                wait_seconds = min(wait_seconds, 5) if (self.test_mode or self.probe_mode) else wait_seconds
                print(f"[INFO] 未收到交互输入，等待候选人列表 {wait_seconds} 秒...")
                deadline = time.time() + wait_seconds
                while time.time() < deadline:
                    cards, _selector = self.find_cards()
                    if cards:
                        return True
                    time.sleep(1)
                return False
            return True
        print(f"[INFO] 非交互模式，等待你手动准备页面，最长 {wait_seconds} 秒...")
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            cards, _selector = self.find_cards()
            if cards:
                return True
            time.sleep(2)
        return False

    def prepare_query_page(self, keyword, location, company, page=1):
        search_cfg = self.config.get("search", {})
        mode = search_cfg.get("navigation_mode", "manual_page")
        entry_url = search_cfg.get("entry_url", "")

        if mode == "direct_url":
            direct_url = self.build_direct_url(keyword, location, company, page=page)
            if not direct_url:
                print("[WARN] direct_url 模式未配置 direct_url_template")
                return False
            self.driver.get(direct_url)
            self.page_delay()
            self.dismiss_overlays()
            return not self.risk_checkpoint_detected()

        if entry_url:
            self.driver.get(entry_url)
            self.page_delay()
            self.dismiss_overlays()
            if self.risk_checkpoint_detected():
                return False

        if mode == "manual_page":
            return self.wait_for_manual_page_ready(keyword, location, company)

        keyword_ok = self.set_input_value(self.selector_cfg("keyword_input"), keyword, "关键词") if keyword else False
        location_ok = self.set_input_value(self.selector_cfg("location_input"), location, "城市") if location else False
        company_ok = self.set_input_value(self.selector_cfg("company_input"), company, "公司") if company else False
        strict_mode = bool(search_cfg.get("strict_mode", False))

        if strict_mode and keyword and not keyword_ok:
            print("[WARN] strict_mode 开启，但关键词没有成功写入，当前查询终止")
            return False

        if not self.click_first(self.selector_cfg("search_button")):
            element, _selector = self.locate_first(self.selector_cfg("keyword_input"))
            if element is not None:
                try:
                    element.send_keys(Keys.ENTER)
                except Exception:
                    pass
        self.page_delay()
        self.dismiss_overlays()
        if self.risk_checkpoint_detected():
            return False

        if location and not location_ok:
            print("[WARN] 城市筛选未确认生效，本轮仅做结果后筛")
        if company and not company_ok:
            print("[WARN] 公司筛选未确认生效，本轮仅做结果后筛")
        return True

    def extract_nested_text(self, root, selectors):
        for selector in selectors:
            try:
                nodes = root.find_elements(By.CSS_SELECTOR, selector)
            except Exception:
                continue
            for node in nodes:
                try:
                    text = _normalize_space(node.text)
                except Exception:
                    continue
                if text:
                    return text
        return ""

    def extract_profile_url(self, card):
        for selector in self.selector_cfg("candidate_link"):
            try:
                links = card.find_elements(By.CSS_SELECTOR, selector)
            except Exception:
                continue
            for link in links:
                try:
                    href = (link.get_attribute("href") or "").strip()
                except Exception:
                    continue
                if href:
                    base_url = self.driver.current_url if self.driver else "https://rd6.zhaopin.com/"
                    return urljoin(base_url, href)
        return ""

    def extract_candidate_id(self, card, profile_url):
        for attr in ["data-resume-id", "data-candidate-id", "data-id", "data-user-id"]:
            try:
                value = (card.get_attribute(attr) or "").strip()
            except Exception:
                continue
            if value:
                return value
        match = re.search(
            r"(?:resume|candidate|detail)[/=_-]+([A-Za-z0-9_-]{6,})|(?:resumeId|id)=([A-Za-z0-9_-]{6,})",
            profile_url or "",
        )
        if match:
            return next((group for group in match.groups() if group), "")
        return ""

    def build_candidate_fingerprint(self, candidate):
        pid = _normalize_space(candidate.get("pid") or candidate.get("source_candidate_id"))
        profile_url = _normalize_space(candidate.get("profile_url") or candidate.get("source_profile_url"))
        if pid or profile_url:
            basis = [value for value in [pid, profile_url] if value]
            return {
                "fingerprint": "zhilian:strong:" + _sha256_text("|".join(basis)),
                "dedupe_level": "strong",
                "fingerprint_basis": basis,
            }

        name = _normalize_for_match(candidate.get("name"))
        company = _normalize_for_match(candidate.get("current_company"))
        title = _normalize_for_match(candidate.get("current_title"))
        location = _normalize_for_match(candidate.get("location"))
        experience = _normalize_for_match(candidate.get("experience"))

        if name and company and title and location:
            basis = [name, company, title, location]
            return {
                "fingerprint": "zhilian:medium:" + _sha256_text("|".join(basis)),
                "dedupe_level": "medium",
                "fingerprint_basis": basis,
            }

        basis = [value for value in [name, company, experience] if value]
        return {
            "fingerprint": "zhilian:weak:" + _sha256_text("|".join(basis)),
            "dedupe_level": "weak",
            "fingerprint_basis": basis,
        }

    def apply_candidate_fingerprint(self, candidate):
        dedupe = self.build_candidate_fingerprint(candidate)
        candidate["dedupe"] = dedupe
        candidate["unique_key"] = dedupe["fingerprint"]
        candidate["dedupe_level"] = dedupe["dedupe_level"]
        return dedupe["fingerprint"]

    def build_candidate_key(self, candidate):
        return self.apply_candidate_fingerprint(candidate)

    def open_profile_link(self, url):
        if not url:
            return ""
        max_opens = _safe_int(self.config.get("safety", {}).get("max_profile_opens_per_run", 8), 8)
        if max_opens >= 0 and self.profile_opens_this_run >= max_opens:
            print("[INFO] 已达到本轮详情页打开上限，跳过更多详情页")
            return ""
        current_handle = self.driver.current_window_handle
        old_handles = list(self.driver.window_handles)
        try:
            self.profile_opens_this_run += 1
            self.driver.execute_script("window.open(arguments[0], '_blank');", url)
            time.sleep(1.0)
            new_handles = [item for item in self.driver.window_handles if item not in old_handles]
            if not new_handles:
                return ""
            self.driver.switch_to.window(new_handles[-1])
            self.wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
            self.page_delay()
            if self.risk_checkpoint_detected():
                self.driver.close()
                self.driver.switch_to.window(current_handle)
                return ""
            text = self.page_text(limit=6000)
            self.driver.close()
            self.driver.switch_to.window(current_handle)
            return text
        except Exception:
            try:
                self.driver.switch_to.window(current_handle)
            except Exception:
                pass
            return ""

    def enrich_candidate_detail(self, selector, index, candidate):
        search_cfg = self.config.get("search", {})
        if not (search_cfg.get("open_detail_panel") or search_cfg.get("open_profile_link")):
            return candidate

        cards, _selector = self.find_cards(selector)
        if index >= len(cards):
            return candidate

        before_url = self.driver.current_url
        before_handles = list(self.driver.window_handles)
        try:
            target = cards[index]
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", target)
            self.detail_open_count += 1
            try:
                target.click()
            except Exception:
                self.driver.execute_script("arguments[0].click();", target)
            self.random_delay(0.8, 1.2)
        except Exception:
            return candidate

        if len(self.driver.window_handles) > len(before_handles):
            detail_text = self.open_profile_link(candidate.get("profile_url"))
            if detail_text:
                candidate["detail_page_text"] = detail_text
                candidate["detail_source"] = "profile_link"
            return candidate

        if search_cfg.get("open_detail_panel"):
            longest_text = ""
            longest_selector = ""
            for selector_name in self.selector_cfg("detail_panel"):
                try:
                    panels = self.driver.find_elements(By.CSS_SELECTOR, selector_name)
                except Exception:
                    continue
                for panel in panels:
                    try:
                        text = _normalize_space(panel.text)
                    except Exception:
                        continue
                    if len(text) > len(longest_text):
                        longest_text = text
                        longest_selector = selector_name
            if len(longest_text) >= 80:
                candidate["detail_panel_text"] = _truncate(longest_text, 6000)
                candidate["detail_source"] = f"panel:{longest_selector}"
                return candidate

        if self.driver.current_url != before_url:
            candidate["detail_page_text"] = self.page_text(limit=6000)
            candidate["detail_source"] = "click_navigated"
            try:
                self.driver.back()
                self.random_delay(0.8, 1.2)
            except Exception:
                pass
            return candidate

        if search_cfg.get("open_profile_link") and candidate.get("profile_url"):
            detail_text = self.open_profile_link(candidate.get("profile_url"))
            if detail_text:
                candidate["detail_page_text"] = detail_text
                candidate["detail_source"] = "profile_link"
        return candidate

    def section_lines(self, text, headings):
        lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
        if not lines:
            return []
        all_headings = {
            "工作经历",
            "工作经验",
            "教育经历",
            "教育背景",
            "项目经历",
            "个人优势",
            "技能特长",
            "求职意向",
            "自我评价",
        }
        start_index = -1
        for idx, line in enumerate(lines):
            if any(heading in line for heading in headings):
                start_index = idx
                break
        if start_index < 0:
            return []
        results = []
        for line in lines[start_index + 1 :]:
            if any(item in line for item in all_headings):
                break
            results.append(line)
            if len(results) >= 12:
                break
        return results

    def extract_candidate_from_card(self, card, page, query_keyword, query_location, query_company):
        profile_url = self.extract_profile_url(card)
        candidate = {
            "pid": self.extract_candidate_id(card, profile_url),
            "name": self.extract_nested_text(card, self.selector_cfg("name")),
            "current_title": self.extract_nested_text(card, self.selector_cfg("title")),
            "current_company": self.extract_nested_text(card, self.selector_cfg("company")),
            "education": self.extract_nested_text(card, self.selector_cfg("education")),
            "experience": self.extract_nested_text(card, self.selector_cfg("experience")),
            "location": self.extract_nested_text(card, self.selector_cfg("location")),
            "profile_url": profile_url,
            "page": page,
            "query_keyword": query_keyword,
            "query_location": query_location,
            "query_company": query_company,
            "card_text": _truncate(_normalize_space(card.text), 1500),
            "scraped_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        candidate["unique_key"] = self.build_candidate_key(candidate)
        return candidate

    def combined_text(self, candidate):
        return " ".join(
            _normalize_space(candidate.get(field, ""))
            for field in [
                "name",
                "current_title",
                "current_company",
                "education",
                "experience",
                "location",
                "card_text",
                "detail_panel_text",
                "detail_page_text",
            ]
        ).lower()

    def extract_years(self, text):
        match = re.search(r"(\d{1,2})\s*年", str(text or ""))
        return _safe_int(match.group(1), 0) if match else 0

    def find_term_hits(self, terms, text, normalized_text=None):
        hits = []
        normalized_text = normalized_text if normalized_text is not None else _normalize_for_match(text)
        raw_text = str(text or "").lower()
        for term in _iter_terms(terms):
            term_norm = _normalize_for_match(term)
            if not term_norm:
                continue
            if term.lower() in raw_text or term_norm in normalized_text:
                if term not in hits:
                    hits.append(term)
        return hits

    def score_candidate(self, candidate, query_company=""):
        profile_cfg = self.config.get("profile", {})
        weights = profile_cfg.get("score_weights", {})
        text = self.combined_text(candidate)
        title = _normalize_space(candidate.get("current_title", "")).lower()
        name = _normalize_space(candidate.get("name", ""))
        company_text = _normalize_space(candidate.get("current_company", ""))
        normalized_text = _normalize_for_match(text)
        score = 0
        reasons = []

        name_hits = self.find_term_hits(profile_cfg.get("target_names", []), name)
        if name_hits:
            score += _safe_int(weights.get("target_name", 45), 45)
            reasons.append(f"姓名匹配:{name_hits[0]}")

        target_companies = list(profile_cfg.get("target_companies", []))
        if query_company:
            target_companies = [query_company] + target_companies
        company_hits = self.find_term_hits(target_companies, f"{company_text} {text}", normalized_text)
        if company_hits:
            score += _safe_int(weights.get("target_company", 30), 30)
            reasons.append(f"公司匹配:{company_hits[0]}")

        title_hits = self.find_term_hits(profile_cfg.get("target_titles", []), title)
        if title_hits:
            score += _safe_int(weights.get("target_title", 16), 16)
            reasons.append(f"职位匹配:{title_hits[0]}")

        keyword_hits = self.find_term_hits(profile_cfg.get("target_keywords", []), text, normalized_text)
        for keyword in keyword_hits[:3]:
            score += _safe_int(weights.get("target_keyword", 10), 10)
            reasons.append(f"命中关键词:{keyword}")

        query_keyword = candidate.get("query_keyword", "")
        query_hits = self.find_term_hits([query_keyword], text, normalized_text)
        if query_hits and query_hits[0] not in keyword_hits:
            score += _safe_int(weights.get("query_keyword", 8), 8)
            reasons.append(f"搜索词匹配:{query_hits[0]}")

        for seniority in profile_cfg.get("seniority_keywords", []):
            if seniority and seniority.lower() in title:
                score += _safe_int(weights.get("seniority", 12), 12)
                reasons.append(f"职级匹配:{seniority}")
                break

        for education in profile_cfg.get("preferred_education", []):
            if education and education.lower() in text:
                score += _safe_int(weights.get("education", 6), 6)
                reasons.append(f"学历匹配:{education}")
                break

        years = self.extract_years(candidate.get("experience") or candidate.get("card_text") or "")
        if years >= 8:
            score += _safe_int(weights.get("experience_8_years", 12), 12)
            reasons.append(f"经验年限:{years}年")
        elif years >= 5:
            score += _safe_int(weights.get("experience_5_years", 8), 8)
            reasons.append(f"经验年限:{years}年")

        if candidate.get("profile_url"):
            score += _safe_int(weights.get("profile_link", 4), 4)
            reasons.append("已捕获智联链接")

        negative_hits = self.find_term_hits(profile_cfg.get("negative_keywords", []), text, normalized_text)
        candidate["negative_hits"] = negative_hits
        if negative_hits:
            penalty = _safe_int(weights.get("negative_keyword", -25), -25)
            score += penalty
            reasons.append(f"负向词:{negative_hits[0]}")
        return min(score, 100), reasons

    def passes_post_filter(self, candidate, query_company):
        if not query_company:
            return True
        if not self.config.get("search", {}).get("require_query_company_match", True):
            return True
        return bool(self.find_term_hits([query_company], self.combined_text(candidate)))

    def go_to_next_page(self):
        button, selector = self.locate_first(self.selector_cfg("next_button"))
        if not button:
            return False
        try:
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", button)
            button.click()
        except Exception:
            try:
                self.driver.execute_script("arguments[0].click();", button)
            except Exception:
                return False
        self.page_delay()
        self.dismiss_overlays()
        print(f"[INFO] 翻页: {selector}")
        return True

    def dump_debug_html(self, label):
        if not self.config.get("output", {}).get("dump_debug_html", True):
            return ""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_label = re.sub(r"[^0-9A-Za-z_-]+", "_", label)[:80]
        output_path = os.path.join(self.debug_dir, f"{timestamp}_{safe_label}.html")
        try:
            with open(output_path, "w", encoding="utf-8") as handle:
                handle.write(self.driver.page_source)
            self.register_output_file(output_path)
            return output_path
        except Exception:
            return ""

    def register_output_file(self, path):
        if path and path not in self.output_files:
            self.output_files.append(path)

    def write_json_file(self, path, payload):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, default=_json_default)
        self.register_output_file(path)
        return path

    def copy_compat_output(self, source_path):
        if not source_path or not os.path.exists(source_path):
            return ""
        compat_path = os.path.join(self.output_dir, os.path.basename(source_path))
        if os.path.normcase(os.path.abspath(source_path)) == os.path.normcase(os.path.abspath(compat_path)):
            return compat_path
        shutil.copy2(source_path, compat_path)
        self.register_output_file(compat_path)
        return compat_path

    def run_filters(self):
        search_cfg = self.config.get("search", {})
        keywords = [self.keyword_override] if self.keyword_override is not None else list(search_cfg.get("keywords", []))
        locations = [self.location_override] if self.location_override is not None else list(search_cfg.get("locations", []))
        companies = [self.company_override] if self.company_override is not None else list(search_cfg.get("companies", []))
        return keywords or [""], locations or [""], companies or [""]

    def build_run_manifest(self):
        keywords, locations, companies = self.run_filters()
        ended_at = datetime.now()
        return {
            "run_id": self.run_id,
            "started_at": self.started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": ended_at.strftime("%Y-%m-%d %H:%M:%S"),
            "mode": self.mode,
            "keywords": keywords,
            "locations": locations,
            "companies": companies,
            "config_path": self.config_path,
            "config_hash": self.config_hash,
            "total_cards_seen": self.total_cards_seen,
            "exported_count": self.exported_count,
            "skipped_low_score_count": self.skipped_low_score_count,
            "skipped_seen_count": self.skipped_seen_count,
            "skipped_company_mismatch_count": self.skipped_company_mismatch_count,
            "detail_open_count": self.detail_open_count,
            "risk_stopped": self.risk_stopped,
            "risk_reason": self.risk_reason,
            "output_files": self.output_files,
            "word_report_path": self.last_word_report_path,
            "candidate_json_path": self.last_json_path,
            "candidate_csv_path": self.last_csv_path,
        }

    def save_run_manifest(self):
        path = os.path.join(self.run_dir, "run_manifest.json")
        manifest = self.build_run_manifest()
        manifest["output_files"] = list(dict.fromkeys(self.output_files + [path]))
        self.write_json_file(path, manifest)
        return path

    def probe(self):
        try:
            self.init_driver()
            if not self.ensure_login():
                self.risk_stopped = True
                self.risk_reason = "not_logged_in"
                return []
            keyword = self.keyword_override or self.config["search"]["keywords"][0]
            location = self.location_override or self.config["search"]["locations"][0]
            company = self.company_override or self.config["search"]["companies"][0]
            self.prepare_query_page(keyword, location, company)
            print(f"[INFO] 当前 URL: {self.driver.current_url}")
            print(f"[INFO] 当前标题: {self.driver.title}")
            print(f"[INFO] 页面文本片段: {_truncate(self.page_text(limit=500), 500)}")
            for key in [
                "keyword_input",
                "location_input",
                "company_input",
                "search_button",
                "list_card",
                "next_button",
                "detail_panel",
            ]:
                hits = []
                total = 0
                selector_reports = []
                for selector in self.selector_cfg(key):
                    try:
                        nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    except Exception:
                        nodes = []
                    count = len(nodes)
                    visible_count = 0
                    looks_candidate_count = 0
                    sample_texts = []
                    for node in nodes:
                        try:
                            if node.is_displayed():
                                visible_count += 1
                        except Exception:
                            pass
                        try:
                            if self.card_looks_candidate(node):
                                looks_candidate_count += 1
                        except Exception:
                            pass
                        if len(sample_texts) < 3:
                            try:
                                text = _truncate(_normalize_space(node.text), 200)
                            except Exception:
                                text = ""
                            if text:
                                sample_texts.append(text)
                    selector_reports.append(
                        {
                            "group": key,
                            "selector": selector,
                            "count": count,
                            "sample_texts": sample_texts,
                            "visible_count": visible_count,
                            "looks_candidate_count": looks_candidate_count,
                        }
                    )
                    if count:
                        hits.append(f"{selector}:{count}")
                        total += count
                print(f"[PROBE] {key}: {total} | {'; '.join(hits[:6]) if hits else 'no-hit'}")
                if not hasattr(self, "_probe_selector_reports"):
                    self._probe_selector_reports = []
                self._probe_selector_reports.extend(selector_reports)
            dump_path = self.dump_debug_html("probe_page")
            if dump_path:
                print(f"[INFO] 页面快照已保存: {dump_path}")
            report_path = os.path.join(
                self.debug_dir,
                f"probe_selector_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
            )
            self.write_json_file(
                report_path,
                {
                    "run_id": self.run_id,
                    "url": self.driver.current_url,
                    "title": self.driver.title,
                    "selectors": getattr(self, "_probe_selector_reports", []),
                },
            )
            print(f"[INFO] selector probe report 已保存: {report_path}")
            return []
        except Exception as exc:
            self.risk_stopped = True
            self.risk_reason = f"probe_error:{type(exc).__name__}"
            print(f"[ERROR] probe 运行失败，已准备写入 manifest: {exc}")
            return []
        finally:
            if not self.last_json_path:
                self.save_candidates([])
            self.save_run_manifest()
            if self.driver:
                self.driver.quit()

    def collect_for_query(self, keyword, location, company, max_pages, remaining_limit):
        results = []
        if remaining_limit <= 0:
            return results
        if not self.prepare_query_page(keyword, location, company, page=1):
            return results

        search_cfg = self.config.get("search", {})
        mode = search_cfg.get("navigation_mode", "manual_page")
        active_selector = ""
        for page in range(1, max_pages + 1):
            if mode == "direct_url" and page > 1:
                direct_url = self.build_direct_url(keyword, location, company, page=page)
                if not direct_url:
                    break
                self.driver.get(direct_url)
                self.page_delay()
                self.dismiss_overlays()
            elif page > 1:
                if not self.go_to_next_page():
                    break

            if self.risk_checkpoint_detected():
                break

            cards, active_selector = self.wait_for_cards()
            if not cards:
                dump_path = self.dump_debug_html(f"no_cards_{keyword}_{location}_{company}_{page}")
                if dump_path:
                    print(f"[WARN] 未找到候选人卡片，已保存快照: {dump_path}")
                break
            self.total_cards_seen += len(cards)

            print(
                f"[INFO] page={page} 命中候选人卡片 {len(cards)} 条 | "
                f"keyword={keyword or '-'} | city={location or '-'} | company={company or '-'}"
            )

            for index in range(len(cards)):
                if len(results) >= remaining_limit:
                    return results
                current_cards, _ = self.find_cards(active_selector)
                if index >= len(current_cards):
                    break
                candidate = self.extract_candidate_from_card(
                    current_cards[index],
                    page=page,
                    query_keyword=keyword,
                    query_location=location,
                    query_company=company,
                )
                if not candidate.get("unique_key"):
                    continue
                if search_cfg.get("skip_seen_candidates", True) and candidate["unique_key"] in self.processed_keys:
                    self.skipped_seen_count += 1
                    continue

                candidate["score"], candidate["match_reasons"] = self.score_candidate(candidate, company)
                min_detail_score = _safe_int(search_cfg.get("min_score_to_open_detail", 35), 35)
                if candidate["score"] >= min_detail_score:
                    candidate = self.enrich_candidate_detail(active_selector, index, candidate)
                if self.risk_stopped:
                    return results
                detail_text = candidate.get("detail_panel_text") or candidate.get("detail_page_text") or ""
                candidate["work_section"] = self.section_lines(detail_text, ["工作经历", "工作经验"])
                candidate["education_section"] = self.section_lines(detail_text, ["教育经历", "教育背景"])
                candidate["score"], candidate["match_reasons"] = self.score_candidate(candidate, company)

                if not self.passes_post_filter(candidate, company):
                    self.skipped_company_mismatch_count += 1
                    continue
                min_export_score = _safe_int(search_cfg.get("min_score_to_export", 15), 15)
                if candidate["score"] < min_export_score:
                    self.skipped_low_score_count += 1
                    continue

                self.processed_keys.add(candidate["unique_key"])
                results.append(candidate)
                self.candidates_saved_this_run += 1
                self.exported_count += 1
                self.maybe_pause_after_candidate()
        return results

    def write_candidate_evidence(self, candidate):
        payload = {
            "run_id": self.run_id,
            "source": "zhilian",
            "source_candidate_id": candidate.get("pid", ""),
            "source_profile_url": candidate.get("profile_url", ""),
            "source_query": {
                "keyword": candidate.get("query_keyword", ""),
                "location": candidate.get("query_location", ""),
                "company": candidate.get("query_company", ""),
            },
            "card_text": candidate.get("card_text", ""),
            "detail_panel_text": candidate.get("detail_panel_text", ""),
            "detail_page_text": candidate.get("detail_page_text", ""),
            "scraped_at": candidate.get("scraped_at", ""),
        }
        evidence_hash = _sha256_text(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        safe_name = re.sub(r"[^0-9A-Za-z_-]+", "_", candidate.get("unique_key", evidence_hash))[:96]
        path = os.path.join(self.evidence_dir, f"{safe_name}.json")
        self.write_json_file(path, {"evidence_hash": evidence_hash, **payload})
        return evidence_hash

    def standardize_candidate(self, candidate):
        self.apply_candidate_fingerprint(candidate)
        detail_text = candidate.get("detail_panel_text") or candidate.get("detail_page_text") or ""
        evidence_hash = self.write_candidate_evidence(candidate)
        standardized = {
            "source": "zhilian",
            "source_candidate_id": candidate.get("pid", ""),
            "source_profile_url": candidate.get("profile_url", ""),
            "source_run_id": self.run_id,
            "source_query": {
                "keyword": candidate.get("query_keyword", ""),
                "location": candidate.get("query_location", ""),
                "company": candidate.get("query_company", ""),
            },
            "identity": {
                "name": candidate.get("name", ""),
                "current_company": candidate.get("current_company", ""),
                "current_title": candidate.get("current_title", ""),
                "location": candidate.get("location", ""),
            },
            "profile": {
                "education": candidate.get("education", ""),
                "experience": candidate.get("experience", ""),
                "work_section": candidate.get("work_section", []),
                "education_section": candidate.get("education_section", []),
                "card_text": candidate.get("card_text", ""),
                "detail_text": detail_text,
            },
            "matching": {
                "score": candidate.get("score", 0),
                "score_version": "zhilian_score_v2",
                "reasons": candidate.get("match_reasons", []),
                "negative_hits": candidate.get("negative_hits", []),
            },
            "dedupe": candidate.get("dedupe") or self.build_candidate_fingerprint(candidate),
            "audit": {
                "scraped_at": candidate.get("scraped_at", ""),
                "detail_opened": bool(candidate.get("detail_source")),
                "risk_flags": [self.risk_reason] if self.risk_stopped and self.risk_reason else [],
                "evidence_hash": evidence_hash,
            },
        }
        candidate.update(standardized)
        candidate["source_candidate_id"] = standardized["source_candidate_id"]
        candidate["source_profile_url"] = standardized["source_profile_url"]
        candidate["source_run_id"] = self.run_id
        candidate["talent_link"] = candidate.get("profile_url", "")
        candidate["dedupe_level"] = standardized["dedupe"].get("dedupe_level", "")
        candidate["evidence_hash"] = evidence_hash
        return candidate

    def add_docx_hyperlink(self, paragraph, text, url):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.opc.constants import RELATIONSHIP_TYPE

        part = paragraph.part
        rel_id = part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
        hyperlink = OxmlElement("w:hyperlink")
        hyperlink.set(qn("r:id"), rel_id)

        run = OxmlElement("w:r")
        r_pr = OxmlElement("w:rPr")
        color = OxmlElement("w:color")
        color.set(qn("w:val"), "0563C1")
        underline = OxmlElement("w:u")
        underline.set(qn("w:val"), "single")
        r_pr.append(color)
        r_pr.append(underline)
        run.append(r_pr)

        text_node = OxmlElement("w:t")
        text_node.text = text
        run.append(text_node)
        hyperlink.append(run)
        paragraph._p.append(hyperlink)

    def save_word_report(self, ordered_candidates, timestamp):
        output_cfg = self.config.get("output", {})
        if not output_cfg.get("word_report", True):
            return ""
        try:
            from docx import Document
            from docx.shared import Pt
        except ImportError:
            print("[WARN] 未安装 python-docx，已跳过 Word 报告。请运行: pip install python-docx")
            return ""

        limit = _safe_int(output_cfg.get("word_report_limit", 50), 50)
        report_items = ordered_candidates[:limit] if limit > 0 else ordered_candidates
        fixed_name = str(output_cfg.get("word_filename", "")).strip()
        filename = fixed_name or f"zhilian_talent_report_{timestamp}.docx"
        path = self.resolve_path(filename) if os.path.isabs(filename) else os.path.join(self.run_dir, filename)
        os.makedirs(os.path.dirname(path), exist_ok=True)

        document = Document()
        styles = document.styles
        styles["Normal"].font.name = "Microsoft YaHei"
        styles["Normal"].font.size = Pt(10.5)

        document.add_heading("智联人才寻访报告", 0)
        document.add_paragraph(f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        document.add_paragraph(f"候选人数：{len(ordered_candidates)}，报告展示：{len(report_items)}")

        for idx, item in enumerate(report_items, start=1):
            name = item.get("name") or "未识别姓名"
            title = item.get("current_title") or "未识别职位"
            company = item.get("current_company") or "未识别公司"
            document.add_heading(f"{idx}. {name} | {company} | {title}", level=1)

            summary = document.add_paragraph()
            summary.add_run("匹配分：").bold = True
            summary.add_run(str(item.get("score", "")))
            summary.add_run("    城市：").bold = True
            summary.add_run(item.get("location", "") or "-")
            summary.add_run("    经验：").bold = True
            summary.add_run(item.get("experience", "") or "-")
            summary.add_run("    学历：").bold = True
            summary.add_run(item.get("education", "") or "-")

            link = item.get("profile_url") or item.get("talent_link") or ""
            link_paragraph = document.add_paragraph()
            link_paragraph.add_run("智联人才链接：").bold = True
            if link:
                self.add_docx_hyperlink(link_paragraph, link, link)
            else:
                link_paragraph.add_run("未捕获")

            reasons = item.get("match_reasons") or []
            if reasons:
                document.add_paragraph("匹配原因：" + "；".join(reasons))
            query = " / ".join(
                value for value in [item.get("query_keyword"), item.get("query_location"), item.get("query_company")] if value
            )
            if query:
                document.add_paragraph("来源搜索：" + query)

            for label, key in [("工作经历摘要", "work_section"), ("教育经历摘要", "education_section")]:
                values = item.get(key) or []
                if values:
                    document.add_paragraph(label + "：")
                    for line in values[:6]:
                        document.add_paragraph(_truncate(line, 260), style="List Bullet")

            card_text = _truncate(item.get("card_text", ""), 500)
            if card_text:
                document.add_paragraph("卡片原文：" + card_text)

        document.save(path)
        self.register_output_file(path)
        self.copy_compat_output(path)
        return path

    def recommended_action(self, candidate):
        dedupe_level = candidate.get("dedupe_level") or candidate.get("dedupe", {}).get("dedupe_level", "")
        if dedupe_level == "weak":
            return "可能重复"
        score = _safe_int(candidate.get("score", 0), 0)
        if score >= 60:
            return "人工查看"
        if score >= 35:
            return "暂缓"
        return "排除"

    def save_review_queue(self, ordered_candidates, timestamp):
        path = os.path.join(self.run_dir, "review_queue.csv")
        columns = [
            "rank",
            "name",
            "current_company",
            "current_title",
            "location",
            "experience",
            "education",
            "score",
            "reasons",
            "profile_url",
            "recommended_action",
        ]
        with open(path, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            for rank, item in enumerate(ordered_candidates, start=1):
                writer.writerow(
                    {
                        "rank": rank,
                        "name": item.get("name", ""),
                        "current_company": item.get("current_company", ""),
                        "current_title": item.get("current_title", ""),
                        "location": item.get("location", ""),
                        "experience": item.get("experience", ""),
                        "education": item.get("education", ""),
                        "score": item.get("score", 0),
                        "reasons": "；".join(item.get("match_reasons", []) or []),
                        "profile_url": item.get("profile_url", ""),
                        "recommended_action": self.recommended_action(item),
                    }
                )
        self.register_output_file(path)
        self.copy_compat_output(path)
        return path

    def save_candidates(self, candidates):
        output_cfg = self.config.get("output", {})
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        ordered = sorted(
            [self.standardize_candidate(dict(item)) for item in candidates],
            key=lambda item: item.get("score", 0),
            reverse=True,
        )
        columns = [
            "unique_key",
            "pid",
            "source_run_id",
            "name",
            "current_title",
            "current_company",
            "education",
            "experience",
            "location",
            "profile_url",
            "talent_link",
            "page",
            "query_keyword",
            "query_location",
            "query_company",
            "score",
            "match_reasons",
            "card_text",
            "detail_panel_text",
            "detail_page_text",
            "work_section",
            "education_section",
            "detail_source",
            "dedupe_level",
            "evidence_hash",
            "scraped_at",
        ]

        json_filename = f"zhilian_candidates_{timestamp}.json"
        csv_filename = f"zhilian_candidates_{timestamp}.csv"
        json_path = os.path.join(self.run_dir, json_filename)
        csv_path = os.path.join(self.run_dir, csv_filename)

        self.write_json_file(json_path, ordered)
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            for item in ordered:
                row = {}
                for column in columns:
                    value = item.get(column, "")
                    row[column] = json.dumps(value, ensure_ascii=False) if isinstance(value, (list, dict)) else value
                writer.writerow(row)
        self.register_output_file(csv_path)

        self.copy_compat_output(json_path)
        self.copy_compat_output(csv_path)
        self.last_json_path = json_path
        self.last_csv_path = csv_path
        self.last_word_report_path = self.save_word_report(ordered, timestamp)
        self.last_review_queue_path = self.save_review_queue(ordered, timestamp)
        return json_path

    def run(self):
        search_cfg = self.config.get("search", {})
        keywords, locations, companies = self.run_filters()

        if self.test_mode:
            max_pages = 1
            run_limit = min(5, _safe_int(search_cfg.get("max_candidates_per_run", 20), 20))
        else:
            max_pages = max(1, _safe_int(search_cfg.get("max_pages", 2), 2))
            run_limit = max(1, _safe_int(search_cfg.get("max_candidates_per_run", 20), 20))

        results = []
        try:
            self.init_driver()
            if not self.ensure_login():
                self.risk_stopped = True
                self.risk_reason = "not_logged_in"
                return results

            for keyword in keywords:
                for location in locations:
                    for company in companies:
                        if len(results) >= run_limit or self.risk_stopped:
                            break
                        batch = self.collect_for_query(
                            keyword,
                            location,
                            company,
                            max_pages=max_pages,
                            remaining_limit=run_limit - len(results),
                        )
                        results.extend(batch)
                    if len(results) >= run_limit or self.risk_stopped:
                        break
                    if len(results) >= run_limit or self.risk_stopped:
                        break
            return results
        except Exception as exc:
            self.risk_stopped = True
            self.risk_reason = f"runtime_error:{type(exc).__name__}"
            print(f"[ERROR] 本轮运行失败，已准备写入 manifest: {exc}")
            return results
        finally:
            if not self.last_json_path:
                output_path = self.save_candidates(results)
            else:
                output_path = self.last_json_path
            self.state["history"].append(
                {
                    "ran_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "run_id": self.run_id,
                    "count": len(results),
                    "output_path": output_path,
                    "candidate_json_path": self.last_json_path,
                    "candidate_csv_path": self.last_csv_path,
                    "word_report_path": self.last_word_report_path,
                    "test_mode": self.test_mode,
                    "risk_stopped": self.risk_stopped,
                    "risk_reason": self.risk_reason,
                }
            )
            self.save_state()
            self.save_run_manifest()
            print(f"[INFO] 本轮输出 {len(results)} 条候选人 -> {output_path}")
            if self.last_word_report_path:
                print(f"[INFO] Word 人才寻访报告 -> {self.last_word_report_path}")
            if self.driver:
                self.driver.quit()


def run_once(args):
    rpa = ZhilianRPA(
        config_path=args.config,
        test_mode=args.test,
        probe_mode=args.probe,
        keyword_override=args.keyword,
        location_override=args.location,
        company_override=args.company,
        navigation_mode_override=args.navigation_mode,
        entry_url_override=args.entry_url,
    )
    if args.probe:
        return rpa.probe()
    return rpa.run()


def main():
    parser = argparse.ArgumentParser(description="Zhilian screening-first RPA")
    parser.add_argument("--config", default="config.yaml", help="Path to config YAML")
    parser.add_argument("--test", action="store_true", help="Run a small trial collection")
    parser.add_argument("--probe", action="store_true", help="Inspect selectors and dump page HTML")
    parser.add_argument("--schedule", action="store_true", help="Run on schedule")
    parser.add_argument("--keyword", help="Override keyword")
    parser.add_argument("--location", help="Override location")
    parser.add_argument("--company", help="Override company")
    parser.add_argument(
        "--navigation-mode",
        choices=["manual_page", "form_fill", "direct_url"],
        help="Override search.navigation_mode",
    )
    parser.add_argument("--entry-url", help="Override search.entry_url")
    args = parser.parse_args()

    if args.schedule:
        holder = ZhilianRPA(config_path=args.config)
        schedule_time = holder.config.get("schedule", {}).get("time", "09:00")
        schedule.every().day.at(schedule_time).do(lambda: run_once(args))
        print(f"[INFO] 定时模式已启动，每天 {schedule_time} 运行一次，按 Ctrl+C 退出")
        while True:
            schedule.run_pending()
            time.sleep(30)
    else:
        run_once(args)


if __name__ == "__main__":
    main()
