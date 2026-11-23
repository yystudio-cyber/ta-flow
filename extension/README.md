> 本目录下有**两个互不相干的扩展**：
> - `boss-match-score/` —— TA 匹配分助手（BOSS 招聘端），即本文档；
> - `feishu-req2job/` —— 飞书需求 → 职位 一键复制，见 [feishu-req2job/README.md](feishu-req2job/README.md)。
>
> 两者分别独立打包、独立安装，不共享代码也不共享存储。飞书那个只在 `*.feishu.cn/hire/job*`
> 上生效，不申请任何 Chrome 权限，与 BOSS 线的风险模型完全无关。

# TA 匹配分助手（浏览器扩展）· v3

人工 sourcing 时，在 BOSS「推荐牛人」的每张候选人卡片右上角实时显示与**当前激活岗位**的匹配分。

给真人用，不是给 RPA 用——你自己刷 BOSS 找人的时候，扫一眼就知道哪些值得点开。

> **升级提示**：装过旧版的，请到 `chrome://extensions` 点这张卡片上的「刷新 ⟳」。
> 平台工具库会检测到 Chrome 里在跑的版本与磁盘不一致并弹黄条提示。

---

## v3 定版说明（2026-08-03）

v3 不是新功能版本，是**把现有架构下该做对的事全部做对**之后的定版。相对 v2.6：

| 修的东西 | 原来的表现 |
|---|---|
| JD 的「应用域 / 任务点」全链路打通 | v4 引擎 40% 权重的两维在生产恒为「JD未设」，实测把人工 80 分的人排在 60 分的人后面 |
| 岗位职责字段错位 | UI 存 `basic.responsibilities`，引擎读顶层，用户填的职责到不了引擎 |
| 保存岗位会丢字段 | 编辑任一岗位就静默抹掉表单没覆盖的字段 |
| 权重表 8 维 → 14 维 | UI 显示的「合计 100%」是假的，用户调不到主导的两维 |
| 硬门槛 / 年龄区间没有入口 | 文档写了「有开关」，实际没有 |
| 语义相似度静默归零 | 词典外的中文文本相似度恒为 0（详见下节） |

**评分口径本身没变**（`scoring-universal.js` 的算法与权重比例未动），所以 v3 与 v2.6
对同一个人、同一份 JD 打出的分**一致**——变的是那些以前根本传不到引擎的配置现在传到了。

### 关于语义匹配：查清了，结论是继续关闭

`semantic-provider.js` 有一个静默 bug：分词器对词典外的中文串逐字切分，而归一化又把单字
全部丢弃，导致**非汽车领域的文本相似度恒等于 0**——不报错，模块整体失效。
修复后重跑三组对照（`npm run score:eval -- --only=full --semantic=none|default|domain`）：

```
semantic=none     分档命中 100%  MAE 1.5  最大偏差 3    ← 保持这个
semantic=default  分档命中 100%  MAE 6.0  最大偏差 9
semantic=domain   分档命中  50%  MAE 7.0  最大偏差 10   ← 跌破合格线
```

开语义会整体抬高分数并压缩档间距，排序仍对但标定变差。**所以维持关闭**——
区别在于现在这个结论有对照数据支撑，而不是"没敢开"。
回归闸门见 `npm run semantic:check`（32 项），防止那个归零 bug 再回来。

> 样本仅 1 个岗位 2 个人，证据偏薄。锚点集扩到 3 个岗位以上时值得重跑这三组对照。

---

## 为什么是扩展，而不是平台注入

平台原来的做法是通过 CDP（`Page.addScriptToEvaluateOnNewDocument`）往页面注入脚本。这条路的前提是
**浏览器必须带 `--remote-debugging-port` 启动并被程序附着**——而这正好落在 BOSS 招聘端的自动化检测
射程里（见 `BOSS-RPA风险调查.md` §5：27 项 CDP 全局变量检测、10027 webdriver toString 反 hook、
11 项 Chrome 特性缺失检测）。为了显示一个徽章去开调试端口，是用最高风险的方式实现最低风险的需求。

浏览器扩展是 Chrome 原生能力：不需要调试端口、不需要程序附着、content script 天然运行在隔离世界，
和几百万人日常装扩展没有区别。

### 风险边界（三条硬约束，改代码时勿破）

1. **零平台请求**。已证实的 BOSS 插件封号案例（`boss-show-time` issue #42）根因是插件调
   `/wapi/zpgeek/job/detail.json` 触发接口限流 → 人机验证 → 短时封号。**封的是"发请求"，不是"贴 DOM"**。
   本扩展一个 zhipin 请求都不发，只读页面已经渲染出来的文本。
2. **避开 DOM 蜜罐**。登记册记录 BOSS 会按类名点名检测特定招聘扩展：`#lk-docker`(10007)、
   `.glue-toolbar`(10009)、`.beisenkeepcore`(10013，北森招聘 SaaS)、React DevTools(10021)。
   本扩展绝不使用上述任何标识：注入的宿主是一个**无类名、无 id** 的 `<span>`，
   全部可见元素装在 `mode:'closed'` 的 Shadow DOM 里——页面 JS 拿不到它的 shadowRoot，
   全局 `document.querySelector` 也命中不到徽章（有测试断言守着）。
3. **只读不写**。不点击、不打招呼、不收藏、不改页面数据，纯展示。

> 据实说明，不粉饰：贴徽章必然留下痕迹——每张候选人卡片会被插入一个 `<span>` 宿主，
> 卡片自身若是 `position:static` 会被补成 `relative`。这是显示分数的最小代价，做不到为零。

---

## 四线隔离矩阵（为什么插件线绝不能被 puppeteer 附着）

全系统四条线的浏览器 / profile / 调试端口 / 附着状态必须严格区分。任何两条线共用同一个
浏览器实例，风险高的那条线就会把风险传染给风险低的那条。

| 线 | 角色 | 浏览器 | Profile | CDP 端口 | 是否被 puppeteer 附着 | 为什么 |
|---|---|---|---|---|---|---|
| 线 2 · 匹配分插件（本扩展） | 真人手动 sourcing 时显示匹配分 | **用户日常 Chrome**（默认 profile） | `%LOCALAPPDATA%\Google\Chrome\User Data\Default`（或用户自己的 Profile） | 无 / 禁开 | **绝不** | 插件零风险的两条前提：<br>1) 不被 puppeteer 附着 — 一旦附着，CDP 检测面是**浏览器级**的，该浏览器里**所有页面**都进入 BOSS 自动化检测射程，content script 全程暴露；<br>2) 不向 zhipin.com 发任何请求 — 插件只读 DOM，不触发任何接口限流。<br>这两条全中，插件才是"零风险"。破任何一条，风险模型就从「贴 DOM 徽章」变成「被识别为自动化工具」。 |
| 线 3 · 行为采集插件（**已剥离为独立仓**：桌面\招聘行为采集插件，ID `pbdfkefdkcbmmmgpiopfomjkdcbkllck`） | 记录真人浏览候选人的行为（看了谁/多久/约了谁），供内部研究 | **用户日常 Chrome**（默认 profile） | 同线 2 | 无 / 禁开 | **绝不** | 与线 2 同理：纯只读采集、零网络、零 DOM 注入，前提也是"装在日常 Chrome 且不被附着"。它不再是平台的一部分（平台安装包/工具库/测试链都不含它），但平台仍把它的 ID 纳入 RPA 隔离黑名单——因为一旦它混进 RPA profile 被附着，同样会把这个只读插件拖进自动化检测射程。 |
| 线 1 · BOSS RPA | 午休自动浏览 / 收藏 / 打招呼 | **平台专用 Chrome**（独立进程） | `%APPDATA%\TA Flow\chrome-profile` | 9222（默认） | **必须**（不附着就没法驱动） | 接受一定风险但绝不能封号。反检测靠 rebrowser-puppeteer + 拟人化节奏 + 风控收紧来对冲。它存在的意义就是"替真人干重复活"，被附着是天生的。 |
| 线 4 · 工具浏览器（飞书搬运等内部工具） | 飞书字段搬运、JR 快照 | **平台工具专用 Chrome**（独立进程） | `chrome-profile-tools`（与 RPA 同目录级别） | 9333（固定） | **是**（注入工具脚本） | 只访问飞书等内部办公系统，不碰招聘站点（ANTI_DETECT_HOSTS 闸门挡住），所以附着不构成 BOSS 侧风险。但仍与 RPA 实例严格隔离（不同 profile、不同端口），避免关工具把 RPA 一起杀掉、或两实例互踢 SingletonLock。 |

> **为什么插件线绝不能被附着**（一句话版）：CDP 检测是**浏览器级**的——只要同一个浏览器被 puppeteer
> attach 了，它里面所有 tab、所有 frame、所有扩展的 content script 都在被检测的进程里；BOSS
> 做的是"这个 Chrome 实例是不是被自动化工具控制"的判断，而不是"这个页面是不是被自动化控制"。
> 插件装在日常 Chrome 里、日常 Chrome 不被附着，是插件线能自称"零风险"的**唯一**前提。

### 隔离闸门（代码里的硬约束）

- **R1 设置层黑名单**：`src/main/ipc/settings.ts` 的 `validateBrowserSecurity` 拒绝把
  `userDataDir` 设到系统默认 Chrome/Edge profile（命中则丢弃该键 + console.warn）。
- **R2 启动层兜底**：`src/main/cdp/chrome.ts` 的 `launch / launchDetached / openBrowserForLogin`
  三处，在 `fs.rmSync` 删 SingletonLock 之前再次校验，命中直接抛错、不启动、不删任何文件。
  （顺序不可颠倒：rmSync 是不可逆破坏动作。）
- **R3 连接层拦截**：`chromeManager.connectExisting()` 连接成功后立即检查对端是否装着
  **黑名单里的任一扩展**（匹配分插件 + 行为采集插件，通过 `service_worker` / `background_page`
  target 的 `chrome-extension://<id>/` url 识别；ID 清单见 `chrome.ts` 的 `rejectExtensionIds`），
  命中立即 disconnect 并抛错。防的是 G2：用户自己用 `--remote-debugging-port=9222`
  启动过日常 Chrome，mode:'existing' 时平台直接连上去，R1 设置层校验完全绕过。
- **R4 反向告警**：主进程启动时检查 RPA profile 磁盘上是否有黑名单里的任一扩展（
  匹配分插件 / 行为采集插件，靠 `Extensions/<ID>/` + `Preferences` 文件中的 ID 指纹），命中走
  riskMonitor 留痕 + 系统通知（不弹模态），逐个提示用户在 RPA 专用浏览器里卸载。
- **R5 防漂移**：`scripts/contract-check.mjs` 第 8 节把上述闸门全部纳入静态断言，
  以后有人删掉/挪动这些检查，`npm test` 会直接红。
- **R6 端口归属校验（外部防线）**：调试端口是**全机共享资源**，别的程序（另一个 Chrome、
  别的自动化工具、另一个会话的测试浏览器）完全可能先占住 9222/9333。此前的实现只判
  「端口通不通」，端口一通就当成"我们的浏览器已在跑"，于是往**别人的 Chrome** 里开标签页
  并 attach 上去跑 RPA——隔离被一个与本应用无关的外部进程直接击穿，用户毫无感知。
  现在 `inspectPort()` 判归属：**端口通 + 我们自己的 profile 正被占用 = 我们的；
  端口通 + profile 没被占用 = 别人的，拒绝连接**（靠 user-data-dir 下 `lockfile`/`SingletonLock`
  的独占锁判定）。三条对外路径（`connectExisting` / `openSiteInDebugBrowser` /
  `openBrowserForLogin`）各有一道拒绝，`getBrowserStatus` 也只把"我们的"算作 open。
  拒绝错误必须是 `IsolationViolationError`——普通 `Error` 会被 `launchDetached` 当成
  "端口没开"而继续起新的，漏洞照旧。

### 实操提醒

- ✅ 扩展装在**你日常用的 Chrome** 里
- ❌ 不要装在平台拉起的 RPA Chrome 里
- ❌ 不要在日常 Chrome 启动参数里加 `--remote-debugging-port=9222`
- ❌ 不要把设置里的「用户数据目录」改成日常 Chrome 的 User Data 路径

---

## 安装（一次）

1. Chrome 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本目录下的 `boss-match-score` 文件夹
4. 装好后打开 BOSS「推荐牛人」页，卡片右上角就会出现分数

扩展 ID 是固定的（manifest 里 pin 了公钥）：`hhjilkjdngolnidebdlmkkhpoidegbgc`。
平台的 JD 桥只放行这一个来源，所以不用配任何东西。

> 建议装在**你日常用的那个 Chrome** 里。平台跑 RPA 用的是它自己的独立 profile，两边互不干扰。

---

## 岗位怎么同步

平台启动时会在 `127.0.0.1:17385` 起一个极小的只读服务（`src/main/services/jd-bridge.ts`），
扩展后台每分钟拉一次当前激活岗位，换岗位后自动生效，**不需要你做任何事**。

- 只监听回环地址，不对局域网暴露
- CORS 只放行上面那个固定扩展 ID；网页、BOSS 页面、其它扩展一律 403（已实测）
- 只吐岗位与评分配置，**绝不吐候选人数据**（PII 不出平台，对齐登记册 R2）
- 平台没开着也不影响：扩展用上次缓存继续打分，只是徽章不会跟着换岗位

点扩展图标可以看连接状态、当前岗位、上次同步时间，也能手动「立即同步」。

---

## 评分口径与平台完全一致

评分引擎只有一份源：`src/shared/scoring-universal.js`。构建时**原样内联**进扩展产物，
所以**扩展上看到的分数 = 平台人才库里的分数**，不存在两套口径、也不会各自漂移。

---

## 页面结构采样（适配新页面形态）

插件目前只适配了「推荐牛人」页（`/web/chat/recommend`）的卡片结构。
如果在**搜索页、候选人列表页**等新页面上看不到徽章，可以采一份页面 DOM 骨架上传到平台，
供后续适配使用。

### 触发方式

1. 在 BOSS 页面上点扩展图标，弹出选项页
2. 点「**采样当前页面结构**」按钮（不点就不采，不常驻）
3. 平台工具库→浏览器扩展卡片会出现"已收到 1 份页面结构采样"的提示
4. 点「打开采样目录」可以在文件管理器里看到 `page-structure-<时间戳>.json`

### PII 边界（严格遵守）

采样**只包含** DOM 骨架信息，**绝对不包含**任何候选人信息：

| 采集的 | 不采集的 |
|---|---|
| 标签名（`div`、`li`、`span`…） | 候选人姓名 |
| class 列表 | 公司名 |
| id 属性值 | 学校名 |
| `data-*` 属性的**名称**（不含值） | 期望城市 / 薪资 |
| button/a 上 ≤6 字的文案（"打招呼"、"联系Ta"） | 自我介绍 / 技能标签文字 |
| 页面 URL（脱敏：数字打码） | `data-geekid` 的**值** |

验收标准：把采样文件给一个陌生人看，他不该能还原出任何一个候选人是谁。

采样只在用户点按钮时执行一次，不会常驻后台轮询。唯一的网络目标是 `127.0.0.1:17385`（本机平台），与 BOSS 无任何交互。

---

## 改代码怎么改

```
extension/boss-match-score/
  parts/10-tinyseg.js    分词        ← 改这里
  parts/20-semantic.js   同义词/相似度 ← 改这里
  parts/30-content.js    页面逻辑     ← 改这里
  parts/40-structure.js  页面结构采样  ← 改这里
  content.bundle.js      构建产物，别手改（Chrome 加载的是它）
```

```
npm run ext:build   # 由 parts/*.js + 共享评分引擎生成 content.bundle.js（带 9 类校验闸门）
npm run ext:check   # 只校验产物与源是否同步，提交前用
npm run ext:test    # 真 Chrome 起假 BOSS 列表页跑 37 项渲染断言（逻辑层）
npm run ext:e2e     # 清单级端到端：真扩展装载 + 推荐 iframe + 假 JD 桥 + closed shadow 真分数（12 项）
```

`ext:e2e` 需要 Chrome for Testing（正式版 Chrome 137+ 已封死自动化旁加载扩展，
150 实测连 CDP `Extensions.loadUnpacked` 装上也不注入 content script）。一次性安装：

```
npx @puppeteer/browsers install chrome@stable --path "<仓库>\node_modules\.cache\ta-e2e-browsers"
```

改完在 `chrome://extensions` 点一下扩展卡片上的「刷新 ⟳」按钮即可生效。

> ⚠️ **manifest.json 或 background.js 改动后必须点「刷新」**——扩展的弹窗页每次都
> 从磁盘现读（看起来一直是新的），但注入规则和后台是装载时缓存的。两边不一致时
> 的典型症状就是"弹窗一切正常、页面上一分不出"（2026-07-29 真机事故）。
> 现在扩展每次同步会把自己的版本号捎给平台（`?v=`），版本与磁盘不一致时
> 工具库卡片会弹黄条明确提示去点刷新，不再靠猜。
>
> **all_frames 必须为 true**（manifest 是 JSON 放不下注释，理由记在这里）：
> BOSS 招聘端的候选人卡片全部渲染在 `/web/frame/recommend/` iframe 里，顶层文档上
> `li.card-item` 恒为 0。`all_frames:false` 时脚本只跑在顶层，永远看不到任何一张卡。

> 校验闸门里有一条是**禁止读 `host.shadowRoot`**：宿主是 `mode:'closed'`，该属性恒为 `null`，
> 曾经因此整个扩展一个徽章都渲染不出来。shadow root 一律从 `rootForCard` 这个 WeakMap 取。

---

## 已知限制

- 选择器来自平台 `platform-adapter` 的真机校准结果，BOSS 改版后可能需要重新校准
  （表现是徽章显示 `—`，鼠标悬停有说明）
- 隔离世界读不到页面 Vue 状态，只能取 DOM 文本，所以字段比 RPA 少一些
  （拿得到：期望职位/城市/学历/经验/薪资/标签；拿不到：完整教育与工作经历）
- 首次打开页面时卡片可能还没渲染完，徽章会晚一两秒出现
