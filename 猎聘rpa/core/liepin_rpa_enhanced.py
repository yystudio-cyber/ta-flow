import argparse
import csv
import html as html_lib
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import schedule
import yaml
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains
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


class LiepinRPA:
    def __init__(
        self,
        config_path="config.yaml",
        force_send=False,
        force_dry_run=False,
        force_schedule=False,
        send_limit_override=None,
        test_mode=False,
        strict_filters_override=None,
    ):
        self.driver = None
        self.wait = None
        self.config_path = os.path.abspath(config_path)
        self.base_dir = os.path.dirname(self.config_path)
        self.force_send = force_send
        self.force_dry_run = force_dry_run
        self.force_schedule = force_schedule
        self.send_limit_override = send_limit_override
        self.test_mode = test_mode
        self.strict_filters_override = strict_filters_override

        raw = self.load_config(self.config_path)
        self.config = self.normalize_config(raw)

        login_cfg = self.config.get("login", {})
        output_cfg = self.config.get("output", {})
        self.cookies_file = self.resolve_path(login_cfg.get("cookies_file", "liepin_cookies.json"))
        self.output_dir = self.resolve_path(output_cfg.get("save_path", "./output"))
        self.state_file = self.resolve_path(output_cfg.get("state_file", "./output/run_state.json"))
        os.makedirs(self.output_dir, exist_ok=True)

        self.state = self.load_state()
        self.contacted_urls = set(self.state.get("contacted_profile_urls", []))

    def resolve_path(self, path_value):
        if os.path.isabs(path_value):
            return os.path.normpath(path_value)
        return os.path.normpath(os.path.join(self.base_dir, path_value))

    def load_config(self, config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                content = yaml.safe_load(f)
                return content if isinstance(content, dict) else {}
        except Exception as e:
            print(f"[WARN] 加载配置失败，使用默认配置: {e}")
            return {}

    def normalize_config(self, raw):
        defaults = {
            "login": {
                "manual_login": True,
                "use_saved_cookies": True,
                "cookies_file": "liepin_cookies.json",
            },
            "search": {
                "entry_url": "https://lpt.liepin.com/search",
                "keywords": ["后端开发"],
                "locations": ["杭州"],
                "industries": [""],
                "experience": "",
                "education": "",
                "max_pages": 3,
                "strict_filters": True,
            },
            "anti_detection": {
                "min_delay": 1.0,
                "max_delay": 2.5,
                "scroll_probability": 0.35,
                "action_probability": 0.15,
            },
            "output": {
                "save_candidates": True,
                "save_path": "./output",
                "file_format": "json",
                "state_file": "./output/run_state.json",
                "fixed_filename": "",
            },
            "messaging": {
                "enabled": False,
                "dry_run": True,
                "per_search_limit": 0,
                "global_limit": 20,
                "skip_contacted": True,
                "template": [
                    "您好{name}，看到您的经历和我们岗位方向匹配，想和您进一步沟通。"
                ],
            },
            "schedule": {
                "enabled": False,
                "time": "09:00",
            },
        }

        cfg = _deep_merge(defaults, raw if isinstance(raw, dict) else {})
        legacy = raw if isinstance(raw, dict) else {}

        if isinstance(legacy.get("search_keywords"), list):
            cfg["search"]["keywords"] = legacy["search_keywords"]
        if isinstance(legacy.get("cities"), list):
            cfg["search"]["locations"] = legacy["cities"]
        if isinstance(legacy.get("max_pages"), int):
            cfg["search"]["max_pages"] = legacy["max_pages"]
        if isinstance(legacy.get("output_file"), str):
            cfg["output"]["fixed_filename"] = legacy["output_file"]
        if isinstance(legacy.get("messages"), list):
            cfg["messaging"]["template"] = legacy["messages"]

        if not cfg["search"]["keywords"]:
            cfg["search"]["keywords"] = ["后端开发"]
        if not cfg["search"]["locations"]:
            cfg["search"]["locations"] = [""]
        if not cfg["search"]["industries"]:
            cfg["search"]["industries"] = [""]
        return cfg

    def load_state(self):
        if not os.path.exists(self.state_file):
            return {"contacted_profile_urls": [], "history": []}
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    data.setdefault("contacted_profile_urls", [])
                    data.setdefault("history", [])
                    return data
        except Exception as e:
            print(f"[WARN] 读取状态文件失败，将重建: {e}")
        return {"contacted_profile_urls": [], "history": []}

    def save_state(self):
        self.state["contacted_profile_urls"] = sorted(self.contacted_urls)
        self.state["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)

    def init_driver(self):
        chrome_options = Options()
        chrome_options.add_argument("--disable-blink-features=AutomationControlled")
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
        chrome_options.add_experimental_option("useAutomationExtension", False)
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--disable-extensions")
        chrome_options.add_argument("--disable-features=VizDisplayCompositor")
        chrome_options.add_argument(
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        )
        anti_cfg = self.config.get("anti_detection", {})
        if bool(anti_cfg.get("disable_images", False)):
            chrome_options.add_experimental_option(
                "prefs", {"profile.managed_default_content_settings.images": 2}
            )

        from selenium.webdriver.chrome.service import Service

        def find_cached_driver():
            env_path = os.environ.get("CHROMEDRIVER_PATH", "").strip()
            if env_path and os.path.exists(env_path):
                return env_path
            home = Path.home()
            patterns = [
                home / ".wdm" / "drivers" / "chromedriver" / "win64",
                home / ".wdm" / "drivers" / "chromedriver",
            ]
            hits = []
            for base in patterns:
                if not base.exists():
                    continue
                for path in base.rglob("chromedriver.exe"):
                    hits.append(path)
            if not hits:
                return ""
            hits.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return str(hits[0])

        cached = find_cached_driver()
        if cached:
            print(f"[INFO] 使用本地缓存 ChromeDriver: {cached}")
            self.driver = webdriver.Chrome(service=Service(cached), options=chrome_options)
        else:
            try:
                from webdriver_manager.chrome import ChromeDriverManager

                service = Service(ChromeDriverManager().install())
                self.driver = webdriver.Chrome(service=service, options=chrome_options)
            except Exception as e:
                print(f"[WARN] webdriver-manager 不可用，尝试 Selenium 默认驱动解析: {e}")
                self.driver = webdriver.Chrome(options=chrome_options)

        self.driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"},
        )
        self.driver.set_window_size(1366, 900)
        self.driver.set_page_load_timeout(35)
        self.wait = WebDriverWait(self.driver, 12)

    def safe_get(self, url, timeout_note=""):
        try:
            self.driver.get(url)
            return True
        except Exception as e:
            print(f"[WARN] 页面加载超时或失败{timeout_note}: {e}")
            try:
                self.driver.execute_script("window.stop();")
            except Exception:
                pass
            return False

    def load_cookies(self):
        if not os.path.exists(self.cookies_file):
            return False
        try:
            with open(self.cookies_file, "r", encoding="utf-8") as f:
                cookies = json.load(f)
            self.safe_get("https://www.liepin.com/", " cookie host")
            allowed = {
                "name",
                "value",
                "path",
                "domain",
                "secure",
                "httpOnly",
                "expiry",
                "sameSite",
            }
            for cookie in cookies:
                clean = {k: v for k, v in cookie.items() if k in allowed}
                if "domain" not in clean:
                    clean["domain"] = ".liepin.com"
                if isinstance(clean.get("expiry"), float):
                    clean["expiry"] = int(clean["expiry"])
                try:
                    self.driver.add_cookie(clean)
                except Exception:
                    continue
            return True
        except Exception as e:
            print(f"[WARN] 加载 cookies 失败: {e}")
            return False

    def save_cookies(self):
        try:
            cookies = self.driver.get_cookies()
            with open(self.cookies_file, "w", encoding="utf-8") as f:
                json.dump(cookies, f, ensure_ascii=False, indent=2)
            print(f"[INFO] cookies 已保存: {self.cookies_file}")
        except Exception as e:
            print(f"[WARN] 保存 cookies 失败: {e}")

    def is_logged_in(self):
        current_url = self.driver.current_url.lower()
        if "login" in current_url or "passport" in current_url:
            return False
        checks = [
            "a[href*='logout']",
            ".header-avatar",
            ".user-avatar",
            ".nav-user",
        ]
        for selector in checks:
            if self.driver.find_elements(By.CSS_SELECTOR, selector):
                return True
        return True

    def login(self):
        login_cfg = self.config.get("login", {})
        manual_login = bool(login_cfg.get("manual_login", True))
        use_saved_cookies = bool(login_cfg.get("use_saved_cookies", True))

        self.safe_get("https://www.liepin.com/login", " login")
        time.sleep(2)

        if use_saved_cookies and self.load_cookies():
            # After cookies are added, leave the login URL before checking state;
            # otherwise a valid cookie jar can still look like a failed login.
            self.safe_get("https://lpt.liepin.com/search", " lpt search")
            time.sleep(3)
            if self.is_logged_in():
                print("[INFO] 使用 cookies 登录成功")
                return True

        if not manual_login:
            username = str(login_cfg.get("username", "")).strip()
            password = str(login_cfg.get("password", "")).strip()
            if not username or not password:
                print("[ERROR] 配置了自动登录但缺少账号或密码")
                return False
            try:
                user_input = self.wait.until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, "input[name='login']"))
                )
                pass_input = self.driver.find_element(By.CSS_SELECTOR, "input[type='password']")
                user_input.clear()
                pass_input.clear()
                user_input.send_keys(username)
                pass_input.send_keys(password)
                self.driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
                time.sleep(5)
                if self.is_logged_in():
                    self.save_cookies()
                    print("[INFO] 自动登录成功")
                    return True
                print("[ERROR] 自动登录失败，请检查账号密码或验证码")
                return False
            except Exception as e:
                print(f"[ERROR] 自动登录异常: {e}")
                return False

        print("[ACTION] 请手动登录猎聘后按回车继续...")
        wait_seconds = _safe_int(login_cfg.get("manual_login_wait_seconds", 180), 180)
        use_wait_mode = True
        if False and sys.stdin and sys.stdin.isatty():
            try:
                input()
                use_wait_mode = False
            except EOFError:
                use_wait_mode = True
        if use_wait_mode:
            print(f"[INFO] 当前为非交互终端，自动等待登录 {wait_seconds} 秒...")
            deadline = time.time() + wait_seconds
            while time.time() < deadline:
                if self.is_logged_in():
                    break
                time.sleep(3)
        if self.is_logged_in():
            self.save_cookies()
            print("[INFO] 手动登录成功")
            return True
        print("[ERROR] 未检测到登录状态")
        return False

    def _first_element(self, selectors, clickable=False, timeout=0):
        for selector in selectors:
            try:
                if timeout > 0 and clickable:
                    return WebDriverWait(self.driver, timeout).until(
                        EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
                    )
                if timeout > 0:
                    return WebDriverWait(self.driver, timeout).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, selector))
                    )
                nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
                if nodes:
                    return nodes[0]
            except Exception:
                continue
        return None

    def _verify_filter_applied(self, trigger_element, target_value):
        if trigger_element and target_value in (trigger_element.text or ""):
            return True
        chips = self.driver.find_elements(
            By.CSS_SELECTOR,
            ".selected, .active, .filter-tag, .condition-item, .tag, .ant-tag",
        )
        for chip in chips:
            text = (chip.text or "").strip()
            if target_value and target_value in text:
                return True
        return False

    def _dismiss_overlays(self):
        labels = ["我知道了", "知道了", "关闭", "稍后", "以后再说"]
        for _ in range(3):
            clicked = False
            for btn in self.driver.find_elements(By.TAG_NAME, "button"):
                text = (btn.text or "").strip()
                if text in labels:
                    try:
                        btn.click()
                        clicked = True
                        time.sleep(0.4)
                    except Exception:
                        continue
            if not clicked:
                break

    def _click_search_button(self):
        selectors = [
            "button.ant-lpt-btn-primary.ant-lpt-teno-btn:not(.ant-lpt-btn-sm)",
            "button.ant-lpt-btn-primary:not(.ant-lpt-btn-sm)",
        ]
        for selector in selectors:
            buttons = self.driver.find_elements(By.CSS_SELECTOR, selector)
            for button in buttons:
                text = (button.text or "").strip()
                if text and "搜索" not in text:
                    continue
                try:
                    self.driver.execute_script(
                        "arguments[0].scrollIntoView({block:'center'});", button
                    )
                    time.sleep(0.2)
                    button.click()
                    return True
                except Exception:
                    continue
        # Fallback by xpath text match
        xpath = "//button[.//span[contains(normalize-space(),'搜索')] or contains(normalize-space(),'搜索')]"
        for button in self.driver.find_elements(By.XPATH, xpath):
            try:
                button.click()
                return True
            except Exception:
                continue
        return False

    def _set_keyword_on_new_search_page(self, keyword):
        # Primary position search box on current LPT search page
        selectors = [
            "input#rc_select_1",
            "input[placeholder='搜索职位']",
            "div.job-input input.ant-lpt-input",
            "input.searchInput--KgDn1",
            "input[placeholder*='职位']",
            "input[placeholder*='行业']",
        ]
        for selector in selectors:
            nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
            if not nodes:
                continue
            box = nodes[0]
            try:
                box.click()
                box.clear()
                box.send_keys(keyword)
                time.sleep(0.6)
                box.send_keys(Keys.ENTER)
                return True
            except Exception:
                continue
        return False

    def _set_company_on_new_search_page(self, company_name):
        if not company_name:
            return True
        selectors = [
            "input#rc_select_3",
            "input[placeholder='搜索公司']",
            "div.inputBox--cDAPJ input.ant-lpt-input",
        ]
        for selector in selectors:
            nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
            if not nodes:
                continue
            box = nodes[0]
            try:
                box.click()
                box.clear()
                box.send_keys(company_name)
                time.sleep(0.6)
                box.send_keys(Keys.ENTER)
                return True
            except Exception:
                continue
        return False

    def _extract_company_term(self, keyword):
        terms = self.config.get("search", {}).get(
            "target_companies",
            ["示例科技", "另一家示例公司"],
        )
        for term in terms:
            if term and term.lower() in keyword.lower():
                return term
        return ""

    def _extract_detail_fields(self, detail_text):
        exp = ""
        edu = ""
        loc = ""
        txt = detail_text or ""
        m = re.search(r"(\\d+\\s*年)", txt)
        if m:
            exp = m.group(1)
        for k in ["博士后", "博士", "硕士", "本科", "大专", "中专", "高中"]:
            if k in txt:
                edu = k
                break
        # pick location style like "广州-海珠区" / "上海-浦东新区"
        m2 = re.search(r"([\\u4e00-\\u9fa5]{2,8}\\s*-[\\u4e00-\\u9fa5]{1,12})", txt)
        if m2:
            loc = m2.group(1).replace(" ", "")
        return exp, edu, loc

    def _pick_option_by_text(self, value):
        if not value:
            return True
        text = value.strip()
        xpaths = [
            f"//*[self::li or self::span or self::div or self::a][normalize-space()='{text}']",
            f"//*[self::li or self::span or self::div or self::a][contains(normalize-space(),'{text}')]",
        ]
        for xpath in xpaths:
            nodes = self.driver.find_elements(By.XPATH, xpath)
            for node in nodes:
                if not node.is_displayed():
                    continue
                try:
                    self.driver.execute_script(
                        "arguments[0].scrollIntoView({block:'center'});", node
                    )
                    time.sleep(0.2)
                    node.click()
                    return True
                except Exception:
                    continue
        return False

    def _apply_filter(self, name, value, trigger_selectors, strict_mode):
        if not value:
            return True
        trigger = self._first_element(trigger_selectors, clickable=True, timeout=4)
        if not trigger:
            print(f"[WARN] 未找到筛选入口: {name}")
            return not strict_mode
        try:
            self.driver.execute_script(
                "arguments[0].scrollIntoView({block:'center'});", trigger
            )
            time.sleep(0.3)
            trigger.click()
            time.sleep(0.4)
        except Exception:
            print(f"[WARN] 无法点击筛选入口: {name}")
            return not strict_mode

        picked = self._pick_option_by_text(value)
        if not picked:
            print(f"[WARN] 未找到筛选项 '{name}={value}'")
            return not strict_mode

        time.sleep(0.6)
        verified = self._verify_filter_applied(trigger, value)
        if not verified:
            print(f"[WARN] 筛选项未生效: {name}={value}")
            return not strict_mode
        return True

    def search_candidates(self, keyword, location="", industry="", experience="", education=""):
        search_cfg = self.config.get("search", {})
        strict_filters = bool(search_cfg.get("strict_filters", True))
        if self.strict_filters_override is not None:
            strict_filters = bool(self.strict_filters_override)

        try:
            self.safe_get(search_cfg.get("entry_url"), " search entry")
            time.sleep(2)
            self.run_anti_detection()
            self._dismiss_overlays()

            company_term = self._extract_company_term(keyword)
            effective_keyword = keyword
            if company_term:
                effective_keyword = keyword.replace(company_term, " ").strip()
                if not effective_keyword:
                    effective_keyword = "运营"

            keyword_input = self._first_element(
                [
                    "div.job-input input.ant-lpt-input",
                    "input.searchInput--KgDn1",
                    "input[placeholder*='职位']",
                    "input[placeholder*='关键词']",
                    "input[data-selector='keyword-input']",
                ],
                timeout=8,
            )
            if not keyword_input:
                print("[ERROR] 未找到关键词输入框")
                return False
            if not self._set_keyword_on_new_search_page(effective_keyword):
                keyword_input.clear()
                keyword_input.send_keys(effective_keyword)
                keyword_input.send_keys(Keys.ENTER)

            if company_term and not self._set_company_on_new_search_page(company_term):
                if strict_filters:
                    print(f"[ERROR] 公司筛选未生效: {company_term}")
                    return False
                print(f"[WARN] 公司筛选未生效: {company_term}")

            filters = [
                (
                    "location",
                    location,
                    [
                        "span[data-selector='area-selector']",
                        "span[data-selector='city-selector']",
                        "div.select-city",
                    ],
                ),
                ("industry", industry, ["span[data-selector='industry-selector']"]),
                (
                    "experience",
                    experience,
                    ["span[data-selector='work-year-selector']", "span[data-selector='experience-selector']"],
                ),
                (
                    "education",
                    education,
                    ["span[data-selector='edu-level-selector']", "span[data-selector='education-selector']"],
                ),
            ]
            for name, value, selectors in filters:
                if not value:
                    continue
                # New search page has many options directly visible, try direct text pick first.
                direct_ok = self._pick_option_by_text(value)
                if direct_ok:
                    continue
                if not self._apply_filter(name, value, selectors, strict_filters):
                    if strict_filters:
                        print(f"[ERROR] 严格模式下筛选失败，停止搜索: {name}={value}")
                        return False

            if not self._click_search_button():
                keyword_input.send_keys("\n")

            result_ready = self._first_element(
                [
                    "div[class*='resumeCardWrap']",
                    "div[class*='resumeCardContent']",
                    "div[class*='resumeListBox']",
                    "div.candidate-list",
                    "div.candidate-card",
                    ".candidate-item",
                ],
                timeout=10,
            )
            self._dismiss_overlays()
            if not result_ready:
                body_text = (self.driver.find_element(By.TAG_NAME, "body").text or "").strip()
                if "请设置搜索条件进行搜索" in body_text:
                    print(f"[WARN] 搜索条件未生效，关键词: {keyword}")
                    return False
                print(f"[WARN] 未检测到结果容器，关键词: {keyword}")
                return False

            print(
                f"[INFO] 搜索成功: keyword={keyword}, location={location}, "
                f"industry={industry}, experience={experience}, education={education}"
            )
            return True
        except Exception as e:
            print(f"[ERROR] 搜索失败: {e}")
            return False

    def _safe_text(self, node, selectors):
        for selector in selectors:
            try:
                target = node.find_element(By.CSS_SELECTOR, selector)
                text = (target.text or "").strip()
                if text:
                    return text
            except Exception:
                continue
        return ""

    def _safe_profile_url(self, node):
        anchors = node.find_elements(By.CSS_SELECTOR, "a[href]")
        for anchor in anchors:
            href = (anchor.get_attribute("href") or "").strip()
            if "liepin.com" in href:
                return href
        targets = [node]
        try:
            targets.append(node.find_element(By.XPATH, "./ancestor::li[1]"))
        except Exception:
            pass
        try:
            targets.append(node.find_element(By.XPATH, "./parent::*"))
        except Exception:
            pass
        for target in targets:
            for attr in ["data-resumeurl", "resumeurl"]:
                value = (target.get_attribute(attr) or "").strip()
                if value:
                    return html_lib.unescape(value)
            resume_id = (target.get_attribute("data-resumeidencode") or "").strip()
            if resume_id:
                return (
                    "https://lpt.liepin.com/cvview/showresumedetail"
                    f"?resIdEncode={resume_id}&sfrom=R_SEARCH_CONDITION"
                )
        outer_html = node.get_attribute("outerHTML") or ""
        match = re.search(r'data-resumeurl="([^"]+)"', outer_html)
        if match:
            return html_lib.unescape(match.group(1))
        match = re.search(r'data-resumeidencode="([^"]+)"', outer_html)
        if match:
            resume_id = html_lib.unescape(match.group(1))
            return (
                "https://lpt.liepin.com/cvview/showresumedetail"
                f"?resIdEncode={resume_id}&sfrom=R_SEARCH_CONDITION"
            )
        match = re.search(r"%22res_id%22%3A%22([^%]+)%22", outer_html)
        if match:
            resume_id = html_lib.unescape(match.group(1))
            return (
                "https://lpt.liepin.com/cvview/showresumedetail"
                f"?resIdEncode={resume_id}&sfrom=R_SEARCH_CONDITION"
            )
        return ""

    def _list_candidate_cards(self):
        selectors = [
            "div[class*='resumeCardWrap']",
            "div[class*='resumeCardContent']",
            "div[class*='resumeCard']",
            "div.candidate-card",
            "div.candidate-item",
            ".resume-item",
            "li.candidate-list-item",
        ]
        for selector in selectors:
            cards = self.driver.find_elements(By.CSS_SELECTOR, selector)
            if cards:
                return cards
        return []

    def _next_page(self):
        selectors = [
            "li.ant-lpt-pagination-next button",
            "li.ant-lpt-pagination-next a",
            "li.ant-pagination-next button",
            "li.ant-pagination-next a",
            "a[title='下一页']",
            ".pager-next",
        ]
        for selector in selectors:
            nodes = self.driver.find_elements(By.CSS_SELECTOR, selector)
            if not nodes:
                continue
            btn = nodes[0]
            classes = (btn.get_attribute("class") or "").lower()
            aria_disabled = (btn.get_attribute("aria-disabled") or "").lower()
            if "disabled" in classes or "pagination-disabled" in classes or aria_disabled == "true":
                return False
            try:
                self.driver.execute_script(
                    "arguments[0].scrollIntoView({block:'center'});", btn
                )
                time.sleep(0.3)
                btn.click()
                time.sleep(random.uniform(1.8, 3.2))
                return True
            except Exception:
                continue
        return False

    def extract_candidate_info(self, max_pages=5):
        all_candidates = []
        seen_keys = set()
        current_page = 1

        while current_page <= max_pages:
            self._first_element(
                [
                    "div[class*='resumeCardWrap']",
                    "div[class*='resumeCardContent']",
                    "div[class*='resumeListBox']",
                    "div.candidate-list",
                ],
                timeout=8,
            )
            self._dismiss_overlays()
            cards = self._list_candidate_cards()
            if not cards:
                print(f"[WARN] 第{current_page}页未找到候选人卡片")
                break

            page_candidates = []
            for card in cards:
                try:
                    profile_url = self._safe_profile_url(card)
                    name = self._safe_text(
                        card,
                        [
                            "[class*='nest-resume-personal-name']",
                            "span.candidate-name",
                            ".candidate-name",
                            ".name",
                        ],
                    )
                    detail_text = self._safe_text(
                        card,
                        [
                            "[class*='nest-resume-personal-detail']",
                            ".candidate-detail",
                            ".baseInfo--_2KQY",
                        ],
                    )
                    work_nodes = card.find_elements(By.CSS_SELECTOR, "div.work-item-content")
                    work_lines = [w.text.strip() for w in work_nodes if (w.text or "").strip()]
                    edu_nodes = card.find_elements(By.CSS_SELECTOR, "div.edu-item-content")
                    edu_lines = [e.text.strip() for e in edu_nodes if (e.text or "").strip()]

                    company = ""
                    title = ""
                    if work_lines:
                        parts = [p.strip() for p in re.split(r"[|\\n]", work_lines[0]) if p.strip()]
                        if parts:
                            company = parts[0]
                        if len(parts) >= 2:
                            title = parts[1]
                    exp, edu, loc = self._extract_detail_fields(detail_text)
                    if not edu and edu_lines:
                        for item in edu_lines:
                            for k in ["博士后", "博士", "硕士", "本科", "大专", "中专", "高中"]:
                                if k in item:
                                    edu = k
                                    break
                            if edu:
                                break
                    if not loc:
                        loc = self._safe_text(card, ["span.candidate-location", ".location", ".city"])
                    tags = [
                        t.text.strip()
                        for t in card.find_elements(By.CSS_SELECTOR, "span.tag, .tag, [class*='skills'] span")
                        if t.text.strip()
                    ]
                    card_text = card.text or ""
                    active_status = ""
                    for marker in ["在线", "今天活跃", "3天内活跃", "7天内活跃", "近两周活跃", "一个月内活跃"]:
                        if marker in card_text:
                            active_status = marker
                            break
                    dedupe_key = profile_url or f"{name}|{company}|{title}"
                    if dedupe_key in seen_keys:
                        continue
                    seen_keys.add(dedupe_key)
                    page_candidates.append(
                        {
                            "name": name,
                            "profile_url": profile_url,
                            "title": title,
                            "company": company,
                            "experience": exp,
                            "education": edu,
                            "location": loc,
                            "tags": tags,
                            "active_status": active_status,
                            "card_text": card_text,
                            "detail_text": detail_text,
                            "work_history": work_lines,
                            "education_history": edu_lines,
                            "scraped_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        }
                    )
                except Exception:
                    continue

            all_candidates.extend(page_candidates)
            print(f"[INFO] 第{current_page}页提取 {len(page_candidates)} 条")
            self.run_anti_detection()

            if current_page >= max_pages:
                break
            if not self._next_page():
                break
            current_page += 1

        print(f"[INFO] 总提取 {len(all_candidates)} 条候选人信息")
        return all_candidates

    def send_message(self, candidate_url, message_template):
        if not candidate_url:
            return False
        try:
            self.safe_get(candidate_url, " candidate")
            time.sleep(random.uniform(1.8, 3.0))
            self.run_anti_detection()

            greet_button = self._first_element(
                ["button[data-selector='greet-btn']", ".btn-greet", "button.ant-btn-primary"],
                clickable=True,
                timeout=8,
            )
            if not greet_button:
                print(f"[WARN] 未找到打招呼按钮: {candidate_url}")
                return False
            greet_button.click()

            message_input = self._first_element(
                ["textarea[placeholder*='消息']", "textarea", "div[contenteditable='true']"],
                timeout=8,
            )
            if not message_input:
                print(f"[WARN] 未找到消息输入框: {candidate_url}")
                return False

            message_input.clear()
            message_input.send_keys(message_template)
            send_btn = self._first_element(
                ["button[data-selector='send-btn']", "button[type='submit']", ".send-btn"],
                clickable=True,
                timeout=5,
            )
            if not send_btn:
                print(f"[WARN] 未找到发送按钮: {candidate_url}")
                return False
            send_btn.click()
            time.sleep(random.uniform(1.5, 2.5))
            print(f"[INFO] 发送成功: {candidate_url}")
            return True
        except Exception as e:
            print(f"[ERROR] 发送失败: {candidate_url} | {e}")
            return False

    def run_anti_detection(self):
        anti = self.config.get("anti_detection", {})
        min_delay = float(anti.get("min_delay", 1.0))
        max_delay = float(anti.get("max_delay", 2.5))
        time.sleep(random.uniform(min_delay, max(max_delay, min_delay)))

        if random.random() < float(anti.get("scroll_probability", 0.35)):
            pos = random.randint(120, 1000)
            self.driver.execute_script(f"window.scrollTo(0, {pos});")
            time.sleep(random.uniform(0.2, 0.8))

        if random.random() < 0.25:
            try:
                actions = ActionChains(self.driver)
                actions.move_by_offset(random.randint(1, 60), random.randint(1, 60)).perform()
            except Exception:
                pass

        if random.random() < float(anti.get("action_probability", 0.15)):
            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(random.uniform(0.3, 0.8))
            self.driver.execute_script("window.scrollTo(0, 0);")

    def _dedupe_candidates(self, candidates):
        seen = set()
        output = []
        for item in candidates:
            key = item.get("profile_url") or (
                f"{item.get('name','')}|{item.get('company','')}|{item.get('title','')}"
            )
            if key in seen:
                continue
            seen.add(key)
            output.append(item)
        return output

    def save_candidates(self, candidates):
        output_cfg = self.config.get("output", {})
        if not output_cfg.get("save_candidates", True):
            return None

        file_format = str(output_cfg.get("file_format", "json")).lower()
        fixed_filename = str(output_cfg.get("fixed_filename", "")).strip()
        deduped = self._dedupe_candidates(candidates)

        if fixed_filename:
            filename = self.resolve_path(fixed_filename)
            os.makedirs(os.path.dirname(filename), exist_ok=True)
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            ext = "csv" if file_format == "csv" else "json"
            filename = os.path.join(self.output_dir, f"candidates_{timestamp}.{ext}")

        if file_format == "csv":
            fieldnames = [
                "name",
                "profile_url",
                "title",
                "company",
                "experience",
                "education",
                "location",
                "tags",
                "scraped_at",
            ]
            with open(filename, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for row in deduped:
                    out = dict(row)
                    if isinstance(out.get("tags"), list):
                        out["tags"] = " | ".join(out["tags"])
                    writer.writerow(out)
        else:
            with open(filename, "w", encoding="utf-8") as f:
                json.dump(deduped, f, ensure_ascii=False, indent=2)

        print(f"[INFO] 候选人结果已保存: {filename} (共 {len(deduped)} 条)")
        return filename

    def can_contact(self, profile_url):
        if not profile_url:
            return False
        messaging_cfg = self.config.get("messaging", {})
        if not messaging_cfg.get("skip_contacted", True):
            return True
        return profile_url not in self.contacted_urls

    def mark_contacted(self, profile_url, result, note=""):
        if profile_url and result == "sent":
            self.contacted_urls.add(profile_url)
        history = self.state.setdefault("history", [])
        history.append(
            {
                "profile_url": profile_url,
                "result": result,
                "note": note,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
        )
        if len(history) > 800:
            self.state["history"] = history[-800:]

    def run(self):
        summary = {"saved_file": None, "candidate_count": 0, "sent_count": 0}
        try:
            self.init_driver()
            if not self.login():
                print("[ERROR] 登录失败，任务终止")
                return summary

            search_cfg = self.config.get("search", {})
            keywords = list(search_cfg.get("keywords", []))
            locations = list(search_cfg.get("locations", []))
            industries = list(search_cfg.get("industries", []))
            experience = str(search_cfg.get("experience", "")).strip()
            education = str(search_cfg.get("education", "")).strip()
            max_pages = _safe_int(search_cfg.get("max_pages", 3), 3)

            messaging_cfg = self.config.get("messaging", {})
            send_enabled = bool(messaging_cfg.get("enabled", False))
            dry_run = bool(messaging_cfg.get("dry_run", True))
            if self.force_send:
                send_enabled = True
                dry_run = False
            if self.force_dry_run:
                dry_run = True
            if self.test_mode:
                keywords = keywords[:1]
                locations = locations[:1]
                industries = industries[:1]
                max_pages = 1
                send_enabled = False
                dry_run = True
                print("[INFO] 测试模式已启用: 仅单组合、单页、禁发消息")

            per_search_limit = _safe_int(messaging_cfg.get("per_search_limit", 0), 0)
            global_limit = _safe_int(messaging_cfg.get("global_limit", 20), 20)
            if self.send_limit_override is not None:
                global_limit = max(0, int(self.send_limit_override))
            templates = messaging_cfg.get("template") or [""]

            all_candidates = []
            hit_global_limit = False
            query_count = 0

            for keyword in keywords:
                for location in locations:
                    for industry in industries:
                        query_count += 1
                        print(
                            f"[INFO] 查询#{query_count}: keyword={keyword}, "
                            f"location={location}, industry={industry}"
                        )
                        ok = self.search_candidates(
                            keyword=keyword,
                            location=location,
                            industry=industry,
                            experience=experience,
                            education=education,
                        )
                        if not ok:
                            continue

                        candidates = self.extract_candidate_info(max_pages=max_pages)
                        for candidate in candidates:
                            candidate["source_keyword"] = keyword
                            candidate["source_location"] = location
                            candidate["source_industry"] = industry
                        all_candidates.extend(candidates)
                        sent_this_query = 0

                        if not send_enabled:
                            continue

                        for candidate in candidates:
                            profile_url = candidate.get("profile_url", "")
                            name = candidate.get("name", "") or "候选人"
                            if global_limit > 0 and summary["sent_count"] >= global_limit:
                                hit_global_limit = True
                                break
                            if per_search_limit > 0 and sent_this_query >= per_search_limit:
                                break
                            if not self.can_contact(profile_url):
                                self.mark_contacted(profile_url, "skip", "already_contacted")
                                continue

                            template = random.choice(templates)
                            message = template.replace("{name}", name)

                            if dry_run:
                                print(f"[DRY-RUN] 计划发送: {name} | {profile_url}")
                                self.mark_contacted(profile_url, "planned", "dry_run")
                                continue

                            success = self.send_message(profile_url, message)
                            if success:
                                summary["sent_count"] += 1
                                sent_this_query += 1
                                self.mark_contacted(profile_url, "sent")
                            else:
                                self.mark_contacted(profile_url, "failed", "send_error")
                            self.run_anti_detection()

                        if hit_global_limit:
                            break
                    if hit_global_limit:
                        break
                if hit_global_limit:
                    break

            deduped_all = self._dedupe_candidates(all_candidates)
            summary["candidate_count"] = len(deduped_all)
            summary["saved_file"] = self.save_candidates(deduped_all)
            self.save_state()
            print(
                f"[INFO] 任务完成: candidates={summary['candidate_count']}, "
                f"sent={summary['sent_count']}, dry_run={dry_run}"
            )
            return summary
        except Exception as e:
            print(f"[ERROR] 任务执行异常: {e}")
            self.save_state()
            return summary
        finally:
            self.close()

    def schedule_run(self):
        schedule_cfg = self.config.get("schedule", {})
        enabled = bool(schedule_cfg.get("enabled", False)) or self.force_schedule
        run_time = str(schedule_cfg.get("time", "09:00"))
        if not enabled:
            return self.run()

        print(f"[INFO] 定时任务启动，每天 {run_time} 执行")

        def job():
            print("[INFO] 定时任务触发")
            self.run()

        schedule.every().day.at(run_time).do(job)
        while True:
            schedule.run_pending()
            time.sleep(20)

    def close(self):
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None


def parse_args():
    parser = argparse.ArgumentParser(description="Liepin RPA Enhanced")
    parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    parser.add_argument("--test", action="store_true", help="测试模式：单组合单页、禁发消息")
    parser.add_argument("--send", action="store_true", help="启用真实发送（覆盖 dry_run）")
    parser.add_argument("--dry-run", action="store_true", help="强制 dry-run")
    parser.add_argument("--schedule", action="store_true", help="强制定时运行模式")
    parser.add_argument("--send-limit", type=int, default=None, help="覆盖全局发送上限")
    parser.add_argument("--strict-filters", action="store_true", help="强制严格筛选")
    parser.add_argument("--lenient-filters", action="store_true", help="强制宽松筛选")
    return parser.parse_args()


def main():
    args = parse_args()
    strict_override = None
    if args.strict_filters:
        strict_override = True
    elif args.lenient_filters:
        strict_override = False

    rpa = LiepinRPA(
        config_path=args.config,
        force_send=args.send,
        force_dry_run=args.dry_run,
        force_schedule=args.schedule,
        send_limit_override=args.send_limit,
        test_mode=args.test,
        strict_filters_override=strict_override,
    )
    try:
        rpa.schedule_run()
    except KeyboardInterrupt:
        print("[INFO] 用户中断")


if __name__ == "__main__":
    main()
