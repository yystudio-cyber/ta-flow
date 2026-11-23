# 人岗匹配评分模型 v5 —— 框架方案

> 版本：v5 方案（未实现） · 状态：待评审
> 编写日期：2026-07-31
> 适用范围：TA Flow（BOSS 直聘线）

---

## 目录

- [A. 数据模型](#a-数据模型)
  - [A1 JD 侧字段表](#a1-jd-侧字段表)
  - [A2 候选人侧字段表（三层可得性）](#a2-候选人侧字段表三层可得性)
  - [A3 想要但现实拿不到的字段](#a3-想要但现实拿不到的字段)
- [B. 维度体系](#b-维度体系)
- [C. 评分算法](#c-评分算法)
- [D. 两级评分设计（卡片层 vs 详情层）](#d-两级评分设计)
- [E. 标定与验证流程](#e-标定与验证流程)
- [F. 落地路径与分期计划](#f-落地路径与分期计划)
- [G. 合规与可解释边界](#g-合规与可解释边界)
- [H. 已知边界与失效场景](#h-已知边界与失效场景)
- [参考文献](#参考文献)

---

## A. 数据模型

### 为什么这一节放在最前面

v4 引擎的核心失败不是算法错了，是 **JD 侧的 domain / tasks 字段根本不存在于平台数据模型里**，UI 没录入入口、数据库没列、适配器没提取，导致两个加起来 40% 权重的维度整维 notApplicable 退出，实际生效权重只剩约 58/100。**任何不建立在"平台真实能产生的字段"之上的评分设计都是空中楼阁。**

这一节的每条字段都标注：**现状是什么（读代码确认）、需要变成什么、改动量多大、谁填、在哪填、填多久、不填时怎么降级**。

### A1 JD 侧字段表

**现状确认**：当前 `src/shared/types/index.ts` 的 `interface JD` 只有这些字段：`id / name / title / active / basic{experienceMin, experienceMax, degree, city, salaryMin?, salaryMax?, responsibilities?, ageMin?, ageMax?} / keywords{required, bonus, negative} / industry{preferred, excluded} / companyTier?{prefer?, avoid?} / weights? / weightTemplate? / hardFlags? / createdAt / updatedAt`。

以下是 v5 完整字段表。**"填写成本"按每个岗位估计，单位是人·分钟。**

| # | 字段 | 定义 | 谁填 | 在哪填 | 填写成本 | 不填时降级 | 改动量 |
|---|---|---|---|---|---|---|---|
| **基础信息（已有）** | | | | | | | |
| 1 | basic.experienceMin / Max | 工作年限下限/上限 | HR | JD 编辑页→基本信息 | 0.3 min | 年限维退出加权 | 已有 |
| 2 | basic.degree | 学历要求 | HR | JD 编辑页→基本信息 | 0.3 min | 学历维退出加权 | 已有 |
| 3 | basic.city | 工作城市 | HR | JD 编辑页→基本信息 | 0.3 min | 地理维退出加权 | 已有 |
| 4 | basic.salaryMin / Max | 薪资预算 | HR | JD 编辑页→基本信息 | 0.5 min | 薪资维退出加权 | 已有 |
| 5 | basic.ageMin / Max | 年龄区间（可选） | HR | JD 编辑页→高级设置 | 0.3 min | 年龄维退出加权 | 已有 |
| **关键词（已有，质量低）** | | | | | | | |
| 6 | keywords.required | 必选技能 | HR 手动写 | JD 编辑页→技能要求 | 3~5 min | 硬技能维只有加分/减分词 | 已有 |
| 7 | keywords.bonus | 加分技能 | HR 手动写 | JD 编辑页→技能要求 | 2~3 min | — | 已有 |
| 8 | keywords.negative | 减分/排除技能 | HR 手动写 | JD 编辑页→技能要求 | 1 min | — | 已有 |
| **职责描述（已有，半结构化）** | | | | | | | |
| 9 | responsibilities | 岗位职责文本数组 | HR 粘贴 JD 原文 | JD 编辑页→岗位职责 | 0 min（粘贴） | 项目维弱、不能做任务点抽取 | 已有 |
| 10 | industry.preferred | 偏好行业 | HR 手动写 | JD 编辑页→行业要求 | 1 min | 行业维退出 | 已有 |
| 11 | industry.excluded | 排除行业 | HR 手动写 | JD 编辑页→行业要求 | 1 min | — | 已有 |
| **—— v5 新增：任务点（M2 核心）——** | | | | | | | |
| 12 | **tasks** | 岗位核心任务清单，每个任务含 `{key, label, weight, domainSensitive:boolean, keywords[]}` | **HR + AI 辅助** | **新增 JD 编辑页→任务点标签页** | **AI 抽 + HR 审：~5 min** | taskCoverage 整维 notApplicable 退出（20% 权重） | 大：新增表/UI/桥 |
| | · label | 任务点名称（如 "支付风控规则引擎"） | AI 抽 + HR 审 | 同上 | — | — | — |
| | · weight | 任务重要性 1~5 | HR 调（AI 给建议） | 同上 | — | — | — |
| | · domainSensitive | 是否域敏感（换了场景就不是一回事） | AI 判 + HR 审 | 同上 | — | — | — |
| | · keywords | 该任务的核心技能/技术关键词（3~8 个） | AI 抽 + HR 审 | 同上 | — | — | — |
| **—— v5 新增：岗位画像（用于 v4 的"应用域"升级为"岗位画像"）——** | | | | | | | |
| 13 | **profile.industry** | 目标行业（如 "汽车智能驾驶"） | HR 选（下拉 + 自定义） | **新增 JD 编辑页→岗位画像** | 0.5 min | industry 维单独工作，但 domainFit 退化为关键词匹配 | 中：新增枚举/下拉 |
| 14 | **profile.functionFamily** | 职能族（算法/开发/测试/产品/运营…） | HR 选（下拉） | 同上 | 0.2 min | positionFit 无法用职能族做 cross-family 封顶 | 已有隐含（在 positionFit 启发式里） |
| 15 | **profile.level** | 职级要求（P4/P5/P6…） | HR 选（下拉） | 同上 | 0.3 min | 职级匹配维退出（v5 考虑新增） | 小：新增枚举 |
| 16 | **profile.scenes** | 核心业务场景（如 ["在线交易","核心链路"]，数组） | HR 多选（来自技能词库场景标签） | 同上 | 0.5 min | domainFit 的 scene 级匹配退出，只剩行业级 | 中：依赖技能词库 |
| 17 | **profile.platform** | 技术平台（"服务端"/"移动端"/"云平台"/"嵌入式"…） | HR 选 | 同上 | 0.3 min | 同 scenes | 中：依赖技能词库 |
| **—— v5 新增：公司层级偏好（已有 + 增强）——** | | | | | | | |
| 18 | companyTier.prefer / avoid | 偏好/避开公司 | HR 手动写 | JD 编辑页→公司层级 | 1 min | — | 已有 |
| **—— v5 新增：胜任力模型（远期，P3 后考虑）——** | | | | | | | |
| 19 | competencies | 胜任力维度（沟通/问题解决/抗压…）+ 级别要求 | HR 从公司胜任力库里选 | 新增标签页 | 5~10 min | 胜任力维退出 | 大：需先建公司胜任力库 |

#### 任务点（tasks）的 AI 辅助抽取方案（MVP 核心）

**不要求 HR 从零写任务点——那是 20 分钟/岗的成本，不现实。** 正确路径：

1. HR 粘贴 JD 原文到职责描述框（本来就要粘贴，零额外成本）；
2. 后台用 LLM 从原文里抽取 6~10 个核心任务点，每个任务点自动生成 label / 预估 weight / 预判 domainSensitive / 配 3~8 个关键词；
3. HR 在 UI 上一键审核：删多余的、补漏的、调权重、改 domainSensitive——**平均 3~5 分钟/岗**。

> 经验依据：Moka 的大模型方案支持"JD 粘贴 → AI 抽取胜任力维度 → HR 复核"的工作流，耗时从 30 分钟降到 3~5 分钟 [15]。Eightfold 的技能本体 + 自动映射也在走类似路径 [4]。

### A2 候选人侧字段表（三层可得性）

现实中有 **三层不同的数据密度**，对应三个不同的评分 tier。这是 v4 设计里最被低估的事实——插件卡片层、RPA 列表层、详情页的信息量差距极大，必须在框架里明确分层。

| 来源 | 层级名称 | 怎么拿到 | 信息量概览 | 典型使用场景 |
|---|---|---|---|---|
| 浏览器插件 · hover 卡片 | **card-min**（极简卡） | 纯 DOM 文本，只读已渲染元素 | 约 10 个字段（姓名/职位/公司/年限/学历/城市/薪资/年龄/技能标签/短自我介绍） | 插件在 BOSS 推荐列表上给每个候选人打徽章分 |
| 平台 RPA · 推荐列表 | **card-plus**（半详情） | 读卡片元素关联的 Vue 实例 `__vue__.$data/$props` | 约 30+ 字段：含完整 workHistory（company/industry/position/**description** 500+字 /performance/emphasis 技能标签/startDate·endDate）、education（学校/专业/学历/时间）、selfIntro、matchWords、platformHighlights、年龄、毕业年份等 | RPA 模式自动浏览、批量初筛——**这才是实际能跑的最大数据源** |
| 候选人详情页 | **detail**（完整） | 点进详情页读 DOM / 调详情接口 | 上 100 字段：含 projects（项目名/描述/技术栈）、research（论文/专利）、certifications、期望职位、期望薪资、工作状态、联系方式 | 打开单个候选人详情页后深评——驱动"要不要约面"决策 |

**字段表（标注三层可得性，✓= 能，✗= 不能，△= 部分）**

| 字段 | card-min（插件 DOM） | card-plus（RPA Vue） | detail（详情页） | 用于哪些维度 |
|---|:---:|:---:|:---:|---|
| name | ✓ | ✓ | ✓ | 展示 |
| position（期望职位） | ✓ | ✓ | ✓ | positionFit |
| company（现公司） | ✓ | ✓ | ✓ | companyTier |
| companySize / companyStage | ✗ | ✗ | △（公司主页才有） | companyTier |
| experienceYears | △（从 chips 里解析，误差大） | ✓（从 workHistory 累计 + startDate/endDate） | ✓ | experience |
| degree | ✓ | ✓ | ✓ | degree |
| city（期望城市） | ✓ | ✓ | ✓ | location |
| salary（期望薪资） | ✓ | ✓ | ✓ | salary |
| age | △（chips 解析，常有缺失） | ✓（ageDesc 解析） | ✓ | age |
| **skills（技能标签）** | ✓（tag-list，10~20 个） | ✓（workEmphasisList + markWords + hlmatches）| ✓ | keywords / skillOntology |
| selfIntro（自我介绍） | △（短，常被截断） | ✓（geekDesc.content） | ✓ | keywords / domainFit |
| **workHistory[i].company** | △（只有现公司） | ✓（每段） | ✓ | companyTier / industry / domainFit |
| **workHistory[i].industry** | ✗ | ✓ | ✓ | industry / domainFit |
| **workHistory[i].position** | ✗ | ✓ | ✓ | positionFit / careerTrajectory |
| **workHistory[i].description** | ✗ | ✓（500+ 字 responsibility） | ✓（更完整） | keywords / taskCoverage / domainFit |
| **workHistory[i].performance** | ✗ | ✓ | ✓ | keywords / taskCoverage |
| **workHistory[i].emphasis（平台抽的技能标签）** | ✗ | ✓ | ✓ | skills |
| workHistory[i].startDate / endDate | ✗ | ✓ | ✓ | experience / stability |
| **education[i].school** | △（DOM 里可能有 1 个） | ✓（每段） | ✓ | degree / schoolTier |
| **education[i].major** | ✗ | ✓ | ✓ | degree / majorFit |
| **education[i].degree** | ✗ | ✓ | ✓ | degree |
| **projects** | ✗ | ✗ | ✓ | taskCoverage / projects |
| research（论文/专利） | ✗ | ✗ | △（简历原文中写了才有） | researchOutput |
| matchWords / platformHighlights | ✓ | ✓ | ✓ | 辅助验证 |
| active（活跃状态） | △ | ✓ | ✓ | 非评分，辅助 |
| contacted / seen | ✗ | ✓ | ✓ | 非评分，风控用 |

**核心结论**：
- **不要把 card-plus 叫"卡片层"**——它已经有 workHistory 全文和 education，足以做 domainFit / taskCoverage 的粗判（准确率低于 detail 层，但远高于 card-min）。v4 里"card vs detail"的二分法太粗糙了。
- **插件（card-min）才是真正的"卡片层"**，只有 10 个左右字段，连 workHistory 都只有公司名——在这一层，domainFit / taskCoverage 整维退出是合理的。
- **平台 RPA 模式（card-plus）是性价比最高的评分数据来源**——零额外请求就能拿到接近详情级的经历文本，这是 v4 没有利用到的黄金数据。

### A3 想要但现实拿不到的字段

以下字段是匹配效果提升的重要因子，但平台上拿不到（或拿不到可靠值），**v5 框架明确放弃**，不要硬造：

| 字段 | 为什么想要 | 为什么拿不到 | 放弃的影响 | 替代方案 |
|---|---|---|---|---|
| 候选人真实能力水平（技能熟练度） | "精通 Python"和"了解 Python"差别巨大 | 简历里都写"精通"，自称程度不可信；没有测评/作品 | 硬技能区分度上限被锁死 | 用出现位置（工作经历 vs 技能标签）、出现频次、项目数量做弱权重 |
| 学校层级（985/211/QS 排名） | 学历质量是强信号 | 学校名单要维护、且有歧视合规风险 | 学历维只能卡"学历层次"（本科/硕士），不能区分学校质量 | 可做可选配置，默认关闭（合规保守） |
| 公司层级（大厂/初创/上市） | 公司背景是常用参考 | BOSS 卡片上公司规模/融资阶段字段缺失率高 | 公司层级维区分度低 | 用公司名匹配 companyTier.prefer/avoid 自定义名单 |
| 候选人求职意向强度 / 离职可能性 | 更精准的排序（优先联系想跳槽的） | 只能从 active 状态、更新时间推测 | 排序的"响应率"维度缺失 | active 字段做弱信号，不进主维度 |
| 薪酬期望的真实底线 | 薪资匹配度 | 候选人写的期望薪资常是虚高/区间大 | 薪资维区分度有限 | 只做硬门槛（超预算封顶），不做细匹配 |
| 候选人性格 / 文化适配 / 软技能 | 终极匹配因子 | 除非测，否则简历里全是套话 | — | 留给面试阶段，不进模型 |
| 绩效表现 / 过往产出 | 最直接的能力证据 | 简历里全是"主导/负责/提升了XX%"自吹自擂，无法验证 | — | 看公司层级 + 岗位升级轨迹做弱信号 |

**放弃的代价**：纯基于"做过什么 + 做了多久 + 在哪做 + 技能词"的匹配，本质是**经历相似度**，不是**能力匹配度**。这是所有简历匹配模型的天花板，包括 Eightfold / LinkedIn [3][5]。v5 框架必须诚实地标注这个天花板。

---

## B. 维度体系

### 设计原则

1. **每维都必须回答：依赖哪个真实字段（见 A 节）、card-min/card-plus/detail 三层分别可用吗？** 不可用的维度要清晰退出加权，不要假装在评分。
2. **维度之间的重叠和双重惩罚要明确声明。** 比如"硬技能"和"任务点覆盖"都会对"BEV 命中"加分，不能各打各的、加起来两倍权重——必须有主次。
3. **权重设计参考行业对标**：Greenhouse / Eightfold / Lever / Moka 的公开文档都把技能、经验、学历作为三大核心维度 [1][2][4][15]。

### 维度总表

| # | 维度 | 定义 | 判据 | 依赖字段 | 默认权重 | card-min | card-plus | detail | 典型失效场景 |
|---|---|---|---|---|---:|:---:|:---:|:---:|---|
| 1 | positionFit（职位匹配） | 期望职位与 JD 标题的职能/领域匹配度 | bigram Dice + 职能族归类 + 可选语义匹配 | candidate.position / jd.title | 10 | ✓ | ✓ | ✓ | 跨行业同职能（如"算法工程师"在金融和汽车都是算法）会误判高 |
| 2 | **skillMatch（技能匹配，替代 v4 的 keywords）** | 候选人技能与岗位技能要求的匹配度，基于**技能本体归一化**（同义/上下位/相关），不是纯关键词 | exact / synonym / broader / related 四档加权 + 特异性加权 + 必选词零命中闸门 | candidate.skills / workHistory.description / projects 中抽技能 → 归一化到本体概念 vs jd.keywords.required/bonus/negative → 也归一化 | 20 | △（只有技能标签，无经历正文，召回率低） | ✓（技能标签 + 经历正文抽取） | ✓（项目也参与） | 技能不在本体库里（新出的小众框架）会漏匹配 |
| 3 | **taskCoverage（任务点覆盖，v4 已有，v5 强依赖）** | 候选人经历覆盖了多少岗位核心任务点，区分 direct / transfer / none 三档证据，域敏感任务在异域命中打折扣 | 逐任务点判证据等级，按 task.weight 加权；domainSensitive 任务异域 0.5 折，非域敏感任务异域 1.0 | jd.tasks / candidate.workHistory / projects | 20 | ✗（没有经历正文，整维退出） | ✓（workHistory.description 足够） | ✓（项目也参与，更准） | 任务点关键词太泛（如"沟通"）会导致虚高 |
| 4 | experience（工作年限） | 工作年限与 JD 要求的匹配度 | 低于下限扣分、区间匹配满分、超龄略降 | candidate.experienceYears / jd.basic.experienceMin/Max | 8 | △（解析误差大） | ✓ | ✓ | 年限不等于能力，但这是简历里唯一硬量化指标 |
| 5 | degree（学历） | 学历层次满足度 | 达标 88 / 高一档 96 / 超配回落 90 | candidate.degree / jd.basic.degree | 6 | ✓ | ✓ | ✓ | 学历层次不等于能力；专科升本科的情况解析不准 |
| 6 | industryFit（行业匹配，v4 的 domainFit 改造） | 候选人过往行业与目标行业的距离 | 行业级 + 场景级两级匹配：同行业 92 / 相邻行业 65 / 远行业 25 / 无信号 50 | candidate.workHistory[].industry / company / jd.profile.industry / jd.profile.scenes / jd.profile.platform | 12 | △（只有现公司名） | ✓（每段经历 industry 字段） | ✓ | industry 字段质量参差（BOSS 上的行业标签有时不准确） |
| 7 | companyTier（公司层级） | 现公司规模/阶段/偏好匹配 | 规模分 + 融资分 + 国企/外企/500强分 + JD prefer/avoid 加减 | candidate.company + 规模/阶段/标签 + jd.companyTier.prefer/avoid | 3 | ✗（只有公司名） | △（只有公司名和 industry，规模/融资信息常缺失） | △ | — | 公司层级高不代表这个人能力强，只做参考 |
| 8 | stability（稳定性） | 平均在职时长 | <0.8 年 18 分 / 0.8-1.2 年 35 / 1.2-2 年 58 / 2-3 年 82 / ≥3 年 95 | workHistory 段数 + 总年限 | 3 | ✗ | ✓ | ✓ | 创业公司/收购导致的频繁跳槽可能误伤；1 段经历算不了 |
| 9 | salary（薪资匹配） | 期望薪资与预算的匹配度 | 在范围内 92 / 低于下限 76 / 超出预算按差距扣分 | candidate.salary / jd.basic.salaryMin/Max | 4 | ✓ | ✓ | ✓ | 候选人期望薪资常虚高/写区间 |
| 10 | location（地理位置） | 期望城市与 JD 城市的匹配度 | 同城 98 / 同省 52 / 异地 12 | candidate.city / jd.basic.city | 4 | ✓ | ✓ | ✓ | 异地但愿意搬迁的情况会误判低 |
| 11 | age（年龄，可选） | 年龄在 JD 声明区间内 | 区间内 95 / 超差线性扣 | candidate.age / jd.basic.ageMin/Max | 2 | △（常缺失） | ✓ | ✓ | **默认关闭**，JD 明确声明才启用（合规） |
| 12 | careerTrajectory（职业轨迹，**v5 新增·待验证**） | 职业发展势头（升级/平级/降级/转行） | 工作经历的职位升级幅度、公司升级、跨行业次数 | workHistory[].position + company + 年限 | 5 | ✗ | △（有职位名但无升级语境） | ✓ | 转行的候选人会被低估（但转行本身也是风险，部分合理） |
| 13 | researchOutput（科研产出，v4 已有） | 论文/专利数量 | 顶会 25 / 普通论文 8 / 专利 4，封顶 95 | candidate.research | 2 | ✗ | ✗ | △ | 工程岗作用很小；学术岗作用大 |
| **合计** | | | | | **100** | — | — | — | — |

### 维度间的重叠与双重惩罚风险

| 重叠对 | 重叠内容 | 处理方式 |
|---|---|---|
| **skillMatch ↔ taskCoverage** | 技能命中会同时被两维计分 | **主次分工**：skillMatch 看"有没有这个技术"（广度），taskCoverage 看"在什么场景下用这个技术做了什么任务"（深度 + 域）。taskCoverage 是主，skillMatch 是基础验证。skillMatch 权重 20 低于 v4 的 keywords 24，就是为了减少双重加分。 |
| **positionFit ↔ industryFit ↔ taskCoverage** | 职位/行业/任务都在讲"域匹配" | **三层递进**：positionFit 最粗（头衔）→ industryFit 中等（行业）→ taskCoverage 最细（任务级证据）。权重依次为 10 / 12 / 20，越细的证据权重越高。 |
| **experience ↔ stability** | 都和工作年限相关 | 方向不同：experience 看"够不够年限"，stability 看"跳不跳槽"。独立维度。 |
| **degree ↔ schoolTier ↔ majorFit** | 都和教育相关 | v5 只保留 degree（学历层次）。学校层级和专业匹配放 v6+，因为需要额外本体支持且有合规风险。 |

---

## C. 评分算法

### 设计选择与理由

#### 1. 聚合方式：加权平均（不是深度学习模型）

**为什么不用 BERT/深度学习做端到端评分？**
- **小样本问题**：初期只有 ~16 份带人工分的简历，远不够训练一个可靠的深度模型。ConFit / BERT-PJF 这类方法在万级样本上效果好，但 16 份会严重过拟合 [7][8]。
- **可解释性要求**：招聘 AI 需要每条分数可追溯到证据（合规 + 用户信任），黑箱 embedding 的"为什么匹配"很难讲清楚 [2][4]。Eightfold 有技能本体 + 因子级可视化来解决这个问题，但那是多年积累的结果 [4]。
- **可干预性**：HR 需要能调权重、改阈值、加排除词。加权平均是可解释、可调试、可审计的最简单形式。
- **行业对标**：Greenhouse（Auto-Match）、Lever（Fit Score 的可解释版）、Moka 的 AI 推荐理由，都在向"结构化维度 + 可解释原因"的方向演进，而不是纯黑箱分 [1][2][15]。

**什么时候上深度模型？**
- P3 阶段以后，标注样本 ≥200 份、且建立了技能本体（≥1000 标准概念）后，可以考虑：
  - 双塔 BERT / Sentence-BERT 做语义相似度（取代纯关键词匹配）[9][11]
  - 用对比学习预训练（ConFit 思路）+ LoRA 小样本微调 [8][13]
  - 作为**附加语义分**叠加在规则引擎上，而不是替换

#### 2. 缺失维度处理：整维退出加权（不是补中性分）

延续 v4 的优良设计：判不了的维度整个踢出加权（分子分母都不算），而不是给个 50 分参与。
- **避免"人人都 55 分"的均值压缩问题**——真机已验证过这是区分度的最大杀手。
- **coverage 指标真实反映"这个分靠不靠谱"**。

#### 3. 硬门槛（Knockout）与软扣分的边界

| 类型 | 项目 | 边界判断 |
|---|---|---|
| **硬门槛（mismatch，总分封 45）** | 学历低于要求、经验低于下限 | 这两个是招聘中最常见的硬筛，几乎所有 ATS 都做（Greenhouse 的 must-have、Moka 的硬性过滤）[1][15]。默认开启，可关。 |
| **硬门槛（可选，默认关）** | 薪资超预算、城市不匹配、年龄超区间 | 这三个可以通融（薪资可谈、异地可搬），默认只软扣分。要开硬门槛需 JD 明确声明。 |
| **软闸门（不 mismatch，但封顶）** | 必选词零命中 → 总分封 55（2 个及以上必选词时） | 硬技能全脱靶，说明基础不达标，但学历/薪资/城市的硬门槛没触发，不给 mismatch 只封顶。v3 验证有效。 |
| **软扣分** | 所有维度的正常加减 | — |

**关于 v4 的"必选词零命中闸门"的自查**：
- 对 60 分档（可约面但技能不匹配）的人会不会误伤？比如 B 电商推荐候选人，他的"高并发/分布式/部署"必选词其实都命中了（技术词命中了，只是域不对），所以不会触发闸门。
- 闸门只在**一个必选词都没中**时触发——那确实是基础技能都不沾边的人，封顶 55 合理。

#### 4. 分数校准（Calibration）

延续 v4 的单调校准曲线（Platt 式 S 形与恒等混合 35/65），把加权均值自然堆积的 45-75 密集区拉开。**只做单调变换，不改变排序**——这是 Platt scaling 的核心精神 [19][20]。

**为什么不用 isotonic regression？**
- 小样本（16 份）下 isotonic 容易过拟合到噪声 [20]。
- S 形有先验（评分的天然分布就是中间密两边疏），比非参数的等渗回归更稳。
- LinkedIn 的校准实践也用参数化方法，小众岗位用更简单的校准曲线 [21]。

**校准前后的评估**：
- AUC / NDCG 应基本不变（验证单调变换没打乱排序）；
- ECE（Expected Calibration Error）应显著下降；
- 校准是可选的，关闭时退化为纯加权平均。

#### 5. 排序 vs 绝对分

**招聘本质是排序任务**，不是回归任务。HR 用分数做的决策是"先看谁、约不约"，是相对决策。
- **成对序正确率 ≥ 分档命中率 ≥ MAE**——这是验收指标的优先级。
- 绝对分只在阈值附近（约不约面那条线，60 分左右）才重要，所以档间分离度比 MAE 更硬。
- 参考工业做法：LinkedIn / Eightfold 都强调排序和推荐，不强调 0-100 分的精确性 [3][5]。

### 算法伪代码（与 v4 结构一致，只是维度表换了）

```
scoreCandidate(candidate, jd, thresholds, opts):
  1. 判 tier（card-min / card-plus / detail）
  2. L1 硬门槛过滤 → mismatchReasons
  3. L2 各维度评分（按上表）
  4. 剔除 notApplicable 的维度（分母去掉）
  5. 剔除 available=false 的维度（保留在分母，拉低 coverage）
  6. 加权平均（只对 available 的维度）
  7. 单调校准拉伸
  8. 软闸门（必选词零命中封顶 55）
  9. tier 级极端分压制（card-min 层 [15, 85]）
  10. hard mismatch 时总分封 45
  11. 判 level（high/medium/low/mismatch）
  12. coverage < 75% 或 tier=card-min → lowConfidence=true → high 降为 medium
  13. 产出可解释信息（highlights/gaps/每个维度的 note）
```

---

## D. 两级评分设计

### 明确三层契约（v4 的 card/detail 二分法过于粗糙）

| 层级 | 数据来源 | 信息完整度 | 目标 | 置信度 | 分数区间限制 | 允许动作 |
|---|---|---|---|---|---|---|
| **card-min**（插件徽章） | 插件 DOM 解析 hover 卡片 | 10% | **驱动"要不要 hover 多看一眼"** | 极低 | [15, 85] | 只能展示徽章分，不能做任何自动动作 |
| **card-plus**（RPA 初筛） | RPA 读卡片 Vue 状态 | 60~70% | **驱动"要不要点进详情"** | 中 | [20, 85]？待验证 | 可以做排序、标记"值得点开"，但不做自动打招呼 |
| **detail**（详情页深评） | 详情页 DOM / 详情接口 | 90%+ | **驱动"要不要约面"** | 高 | 无限制（0-100） | high 置信才能进自动打招呼候选（且需人工审核） |

### card-min 层（插件徽章）设计要点

- **能用的维度**：positionFit(10) + skillMatch-低召回版(20) + experience-粗版(8) + degree(6) + salary(4) + location(4) + age(2) ≈ 54 权重可用，其余 46 权重因为 notApplicable 或 available=false 退出。
- **极端分压制**：强制 [15, 85]。证据不足时不许做极端判断——这是产品安全底线。
- **强制 lowConfidence**：即使 coverage 数字上看高（因为很多维 notApplicable 被剔除了），card-min 层天生低置信。
- **只排序不做决策**：分数的作用只是让 recruiter 一眼看到"这个人可能匹配度大概多少"，不触发任何自动化动作。

### card-plus 层（RPA 列表级）设计要点

- **能用的维度**：除了 projects / researchOutput / careerTrajectory 细节外，大部分维度都能用（skillMatch 有 workHistory 描述、taskCoverage 有经历正文、industryFit 有 industry 字段、stability 有起止日期）。
- **为什么这一层最重要**：零额外请求成本，就能拿到 60~70% 的信息量，是性价比最高的评分层级。v4 里 card 层信息严重不足的问题，**在 RPA 模式下其实不存在**——只是 v4 没区分"插件 DOM"和"RPA Vue"。
- **能做什么**：
  - 给推荐列表排序（从顶到底看）
  - 自动收藏"明显匹配且高置信"的候选人（medium 及以上 + coverage≥75%）
  - 过滤掉"明显不匹配"的（low + mismatch）
- **不能做什么**：
  - 自动打招呼（必须详情层 + 人工审核）
  - 给出 90+ 或 10- 的极端分（域判定不够精准，可能错判）

### detail 层（详情页）设计要点

- **信息最全**：projects + research + 更完整的经历描述 → taskCoverage 最准、careerTrajectory 可计算。
- **是"约不约面"决策的评分依据**：80+ 高分的可以推荐优先约，60 以下的可以考虑不约。
- **high 等级（≥75 分）+ coverage≥90% + 非 mismatch** 才能进入"自动打招呼候选池"——但仍然必须人工审核后发，不能全自动发。
  - 合规依据：PIPL 第 24 条第 3 款的"仅通过自动化决策"拒绝权——只要有意义的人工复核，就不算"仅通过" [26]。NYC LL144 也要求人工干预 [24]。

---

## E. 标定与验证流程

### E1 锚点采集口径

**为什么锚点集是 T0**：这是唯一的"真值"——没有人工分的锚点，调权重就是瞎调。

**采集方法（基于 BARS + 锚定评分法的实践）** [16][17]：

1. **每个 TA 提供 4 份典型简历**（对应 4 档）：
   - 90+ 档："面了肯定过、直接 offer 的那种"
   - 80-89 档："挺合适，大概率约面"
   - 70-79 档："还行，约面池边缘，看面试官时间"
   - 60-69 档："不太对口，但技术栈可迁移，可以聊聊看"
   - （60 以下作为负样本，也可采 1~2 份）
2. **每个 TA + 每个岗位 4 份，4 个 TA × 4 个岗位 × 4 档 = 64 份锚点**（理想值）。
   - 初期 MVP：1 个岗位 × 4 个 TA × 4 档 = 16 份。这是现实约束。
3. **评分用 0-100 连续分 + 档位判断**。先让每个 TA 独立打，然后计算评分者间一致性。
4. **锚卷校准（Anchor Rating）** [17]：
   - 选 2~3 份"共识锚卷"（明显高/中/低各 1 份），4 个 TA 先一起讨论对锚卷的打分，统一评分尺度；
   - 然后各自独立评其余的。
   - 这是心理测量学中提升评分者间一致性的标准做法，比"各打各的然后取平均"好很多。

**跨 TA 可比性问题（效度问题）**：
- 4 个 TA 各负责不同的岗位，所以跨 TA 的直接比较没意义——**每个岗位的"档位"是该 TA 的相对档位，不是绝对分数**。
- 不能把 A 岗的 80 分和 B 岗的 80 分直接比——档位的含义是相对于该岗位要求的。
- 这在工业界也是标准做法：Eightfold 的匹配分是"相对于这个岗位"的匹配度，不是绝对能力分 [4]。

### E2 评估指标（按优先级排序）

| 指标 | 定义 | 合格线 | 为什么这个顺序 |
|---|---|---|---|
| **1. 跨档倒挂 = 0** | 人工高档的人被引擎打到低档以下 | 必须为 0 | 最硬：跨档倒挂 = 排序犯方向性错误，HR 不会信这个分 |
| **2. 成对序正确率** | 同岗位内任两人相对高低与人工一致的比例 | ≥90%（目标 100%） | 招聘是排序任务，序对了分差点还能校准 |
| **3. 分档命中率** | 预测分落在人工档位（90+/80-89/70-79/60-69/<60）内的比例 | ≥75% | 档是 HR 真正用的决策单位，比精确分重要 |
| **4. 档间分离度** | 相邻档的预测分均值差 | ≥4 分 | 防止"序对了但全挤在 3 分内"，等于没区分 |
| **5. MAE** | 绝对分平均绝对误差 | ≤8 | 绝对分的准确性，优先级最低 |
| **6. 单点最大偏差** | 单个人的最大偏差 | ≤12 | 防止特别离谱的个例 |

**为什么排序指标 > 绝对分指标**：
- 参考学术 PJF 领域的标准评估：NDCG@k / Precision@k / AUC 都是排序/排序相关指标，MAE/RMSE 用得少 [7][8]。
- 工业界 LinkedIn / Eightfold 也主要看排序质量（Top matches、推荐准确率），不是绝对分的误差 [3][5]。

### E3 防过拟合：小样本下的约束

**现实约束**：初期可能只有 1 个岗位 × 4 个 TA × 4 档 = 16 份锚点。这个样本量下，能调多少参数？

**过拟合风险与参数控制**：
- 加权平均模型的可调参数就是**权重**（13 个维度，每个 1 个权重值 → 13 个参数）+ 几个闸门阈值。
- 16 样本调 13 个参数……**危险**。
- **约束策略**（按严格度递增）：
  1. **先固定大部分权重，只调 2~3 个最关键的**（如 skillMatch 和 taskCoverage 的比例）——其余用经验初值。
  2. **权重模板约束**：tech / functional / management 三种模板，每个岗位只能选模板 + 微调（±5%以内），不能每个岗位单独学一套权重。
  3. **单调约束**：权重相对大小要符合常识（taskCoverage > positionFit，不能反过来）——减少参数自由度。
  4. **留一法交叉验证（LOOCV）**：16 个样本做 16 折留一验证，看每一折留出的那个能不能被排对——这是小样本下的标准验证方法 [19]。
  5. **不调校准曲线参数**：固定 S 形中心 55、斜率 11、混合比 0.35/0.65（v4 就用的），用先验知识而不是数据拟合。
  6. **不做 grid search 调权重**：用常识/对标定初值，锚点集只做验证——而不是"调到过为止"。

**什么时候才允许调权重？**
- 锚点样本数 ≥ 可调参数数 × 10（经验法则，类似于统计功效）。
- 即 13 维权重 → 至少 130 份锚点才能考虑系统的权重学习。
- 在此之前，权重是**设计出来的**（基于领域知识 + 对标），不是学出来的。

**验证集划分**：
- 16 样本太少，不能硬划训练/验证——**留一法或 4 折交叉验证**（每折留 4 份）。
- 每个 TA 的 4 份作为一组，做 leave-one-TA-out 交叉验证（看在一个 TA 的锚点上调的权重能不能推广到另一个 TA）——这是对泛化性的最强检验。

### E4 评分者间一致性（4 个 TA 的分歧处理）

4 个 TA 对同一份简历打分可能不一样，这不是"噪声"而是**真实的主观性**——招聘本身就有主观性。怎么处理：

1. **先测一致性**（评完锚点后立刻做）：
   - 分档用 **Fleiss' kappa**（多评分者、分类变量）[18]
   - 连续分用 **ICC(2,1)**（单个评分者信度）和 **ICC(2,k=4)**（4 人平均的信度）[17]
   - 阈值：ICC ≥ 0.70 才认为 4 人平均分可用作"真值" [17]
2. **如果一致性低怎么办**：
   - **锚卷校准**（见 E1）：拿 2~3 份分歧最大的简历，4 人一起讨论，用 BARS 的方法逐条过行为证据，统一对档位的理解 [16]。
   - 这不是"统一口径"，而是**统一评分尺度**——BARS 设计流程中的 retranslation 步骤就是干这个的 [16]。
   - 校准后重测，直到 ICC ≥ 0.70。
3. **真值怎么取**：
   - ICC(2,4) ≥ 0.70 → 4 人**平均分**作为真值（合理）。
   - ICC(2,4) < 0.70 → **先别用平均分当真值**——说明这 4 个人对"什么叫好"的理解根本不一致，先做校准。
   - 永远不要用"多数决"——那会丢掉重要的边缘案例，而边缘案例才是评分引擎最需要判对的。
4. **分歧大的简历单独标注**：
   - 如果某份简历 4 人打分散度 > 15 分，说明这份是"争议案例"——单独标记，不进锚点训练集。
   - 争议案例可以作为评估集的"困难样本"，专门看引擎在模糊案例上的表现。

---

## F. 落地路径与分期计划

### 核心原则：每一期都要回答"HR 花多少时间、换回来什么"

**不要设计一个需要大量人工标注才能启动的方案。** 初期只有 4 个 TA × ~16 份简历，必须能启动。

### P0：最小可用版本（MVP）—— 2 周，几乎零 HR 成本

**目标**：修复 v4 的"两个维度整维退出导致倒挂"问题，把分档命中从 0% 拉到 ≥75%。

**要做的事**：

| # | 事项 | 谁做 | 工时 | 改动量 |
|---|---|---|---|---|
| 1 | **修复 tier 分层：把 RPA 卡片层的 workHistory 用上** — 实际上 card-plus 层已经有 description，v4 的"卡片层任务点覆盖整维退出"是错的。只需在引擎里加一层 tier=card-plus，让它能跑 taskCoverage 和 domainFit。 | 开发 | 2 天 | 中：引擎加 tier 枚举、RPA adapter 传 tier |
| 2 | **任务点 AI 自动抽取 + 审核界面**：从 JD 的 responsibilities 文本里用 LLM 抽 6~10 个任务点（label / weight / domainSensitive / keywords），HR 花 3 分钟审核。 | 开发 + HR | 开发 5 天 + HR 3 min/岗 | 大：新增 LLM 调用 + 新增 UI 标签页 + 存 tasks 字段 |
| 3 | **岗位画像半自动填充**：从 JD 标题 + 行业 + 职责文本里，LLM 建议 profile.industry / scenes / platform，HR 一键确认。 | 开发 + HR | 开发 3 天 + HR 1 min/岗 | 中：新增字段 + UI |
| 4 | **技能本体 v0（最小可用）**：先不搞大而全的本体，就做两件事——同义词表（BEV/Bird's Eye View/鸟瞰/俯视图）、技能词标准化（大小写/空格/缩写归一化）。先解决"同一个技能不同写法"的问题，上下位推理留到 P1。 | 开发 | 3 天 | 小：建 2 张表 + 技能匹配时走归一化 |
| 5 | **锚点采集（第 1 轮）**：4 个 TA × 1 个岗位 × 4 档 = 16 份。先做锚卷校准，再独立打分。 | HR（4 个 TA） | 1~2 小时/人 | 无代码改动 |
| 6 | **验证 score:eval 全绿**：用新引擎 + 新任务点 + 新画像跑锚点集，看指标。 | 开发 | 1 天 | — |

**HR 成本**：每个岗位 ~5 分钟（3 分钟审任务点 + 1 分钟审画像 + 1 分钟微调）。
**效果预期**：分档命中率 ≥ 75%、成对序 ≥ 90%、档间分离度 ≥ 4。
**风险**：如果 LLM 抽的任务点质量差，HR 审核时间会超。需要先做 5 个岗位的试点，测平均审核时间。

### P1：技能本体 v1 + 语义匹配 —— 4~6 周

**目标**：解决"金融风控和电商推荐字面像但实质不同"的核心问题，把区分度从关键词级别提升到概念级别。

**要做的事**：
1. **中文技能本体构建（基于 ESCO + 国家职业技能标准 + BOSS JD 抽取）** [12][14]：
   - 骨架：ESCO 中文 label + O*NET 中英对照 + 国家职业技能标准的技能条目
   - 扩充：从 1000+ BOSS JD 中用 LLM 抽取技能短语，聚类后挂到本体上
   - 目标：≥ 5000 标准技能概念、≥ 3 层级、同义词 ≥ 2 万个
2. **技能匹配升级为 4 档加权**：exact（1.0）/ synonym（0.85）/ broader（0.6）/ related（0.35）
3. **domainFit 升级为概念级**：不再是关键词匹配，而是看"做过的任务"属于哪些场景/行业概念，与 JD 的场景概念在本体中的距离
4. **锚点扩展到 4 个岗位 × 4 个 TA = 64 份**
5. **权重微调**：有 64 份锚点后，可以做 leave-one-TA-out 交叉验证，验证权重的泛化性
6. **careerTrajectory 维度上线**（新增）：从工作经历的职位升级/公司升级看职业发展势头

**HR 成本**：几乎为零——本体是技术活，HR 只需要继续提供锚点。

### P2：深度语义匹配（BERT 双塔）—— 6~8 周（可选）

**目标**：纯关键词匹配无法处理的深层语义（"负责 XX 模块的端到端优化"和"主导 XX 系统从 0 到 1 搭建"其实是类似的工作），用双塔语义模型解决。

**要做的事**：
1. **数据准备**：积累 200+ 标注 pair + 大量无标注 JD/简历文本做对比预训练 [8][13]
2. **模型选型**：中文预训练模型（CPT / RoBERTa-wwm 中文）+ 领域继续预训练（DAPT）+ LoRA 微调 [11]
3. **小样本策略**：ConFit 式对比学习预训练 + 少量标注微调 [8]；FSLPJ 式 few-shot 元学习 [13]
4. **集成方式**：语义分作为附加维度（semanticFit，权重 5~10%）叠加在规则引擎上，不替换规则引擎
5. **可解释性**：语义匹配 + 关键词证据双轨展示，规则引擎的维度级解释仍然保留

**风险**：
- 200 样本可能不够，效果提升有限
- 黑箱分不易解释，需要专门做归因（Attention 可视化等）
- 合规风险增加（算法越复杂，可解释性越难，越接近高风险 AI 系统）

---

## G. 合规与可解释

### 关键结论（基于 AI Act / NYC LL144 / PIPL）

#### 1. 系统定位：AI 辅助，不是 AI 决策——必须守住这条线

- **EU AI Act**：招聘筛选 AI 属于 Annex III 高风险系统，无论辅助还是决策 [22][23]。但**人类监督的有效性直接影响合规义务的履行难度**——Art. 14 要求"确保自然人能有效监督"，如果人只是"橡皮图章"式点确认，不算有效监督 [23]。
- **NYC Local Law 144**：只要工具被用于"辅助或替代"自由裁量决策，就算 AEDT，需要偏见审计 [24][25]。辅助定位不豁免，只是审计难度低一些。
- **PIPL 第 24 条第 3 款**："仅通过自动化决策方式作出对个人权益有重大影响的决定，个人有权要求说明，并有权拒绝" [26]。"仅通过"是关键——有意义的人工复核就不算"仅通过"。

**产品侧的边界原则（必须遵守，不能越）**：

| 原则 | 具体要求 | 为什么 |
|---|---|---|
| **1. 分数永远只作参考** | UI 上明确标注"AI 评分，仅供参考"，不显示"推荐录用""建议淘汰"等定性结论 | 避免被认定为"自动化决策" |
| **2. 人类有最终决定权** | 自动打招呼 / 自动收藏 这类对外动作必须经人工审核后执行，不能全自动 | PIPL / AI Act 的人类监督要求 [22][26] |
| **3. 每条分数可追溯证据** | 每个候选人的分数都能看到"为什么得这个分"——每个维度的得分和依据 | 透明度要求 + 用户信任 + 合规审计 |
| **4. 不使用受保护属性** | 评分模型不直接使用性别、年龄、民族、种族、宗教、婚育状况等受保护属性。年龄维度默认关闭，需 JD 明确声明才启用（且只做区间判断） | 就业促进法第 26、27、30 条的反歧视要求 [27] |
| **5. 人工可覆盖** | HR 可以手动调整某个人的标签/评分、可以标记"算法判错了" | 人类监督权 + 反馈闭环 |
| **6. 可关闭** | 评分功能可以整体关闭，关闭后不影响平台其他功能 | 用户选择权 |
| **7. 偏见定期评估** | 每季度/每半年跑一次性别/年龄/学历分布的偏差检查（看高分池 vs 全量池的分布差异） | NYC LL144 的精神（虽然国内没强制，但作为负责任的 AI 应该做）[24] |

#### 2. 可解释性的呈现层级

参考 Eightfold 的做法（因子级可视化 + 匹配原因列表）[4] 和 Moka 的做法（推荐/淘汰都给理由）[15]：

1. **总分 + 档位**：一眼看大概
2. **3 个亮点 + 3 个短板**：最匹配的 3 个维度 / 最欠缺的 3 个维度
3. **每个维度的 note**：维度分 + 为什么给这个分（一句话解释）
4. **技能级明细**：命中了哪些技能、缺了哪些、哪些是同义匹配、哪些是相关匹配
5. **任务点级明细**（detail 层）：覆盖了哪些任务点、哪些是迁移的、哪些缺了
6. **原始证据**：点击可以跳转到简历中对应的原文段落（最终的可追溯性）

### 3. 数据合规补充

- 候选人简历数据的处理需要符合 PIPL——BOSS 上公开可见的信息可以抓取，但不能用于超出招聘的用途。
- 存储期限：候选人数据不能永久保留，应该有过期/删除机制（3 个月/6 个月）。
- 这个产品是 HR **自己用的内部工具**，不是对外提供的 SaaS——合规义务比 SaaS 产品低，但原则要守。

---

## H. 已知边界与失效场景

至少 5 个真实场景，说明模型会在哪里判错、为什么、以及缓解手段。

### 场景 1：跨域跳槽的复合型人才被低估

**现象**：候选人有 4 年金融风控 + 2 年电商推荐（跳槽到支付公司），技能标签里写的都是 高并发/分布式/规则引擎。模型会因为"有 2 年电商经历"而降低 domainFit 和 taskCoverage 的同域比例，但实际上这个人的金融经验是扎实的。

**为什么会错**：域判定是段级的，有远域段就拉低分数。但跨行业/跨域的复合型人才可能两方面都强。

**缓解手段**：
- taskCoverage 按"最强证据"给分，而不是按段数比例——只要有一段同域经历做过某个任务，就按 direct 给分，不因其他段是远域而打折。
- domainFit 的最高分锚点看"同域经历的最高质量"，而不是段数加权平均——但这需要判断"哪段经历更相关"，复杂度增加。
- 当前设计：域分数是段加权，所以复合背景的人确实会比"纯本域"的人低一点——某种意义上合理（纯本域的更对口），只是不要低太多。

### 场景 2：简历写得烂但人很厉害的候选人被低估

**现象**：技术强但不会写简历，描述写得很短、全是套话、技能词少。模型会因为"文本少 → 命中少"而打低分。

**为什么会错**：所有基于文本的匹配模型都有"简历质量 ≠ 能力"的问题。这是简历筛选的固有缺陷，不是 v5 独有的——人类 recruiter 也会被简历质量影响。

**缓解手段**：
- 用 companyTier / degree / careerTrajectory 这些结构化信号做"保底"——公司好、学历好、职位升级快的人，就算简历写得差，也不该太低分。
- 明确告知用户："这份简历信息量较少，分数可能不准，建议点开详情/查看完整简历。"—— lowConfidence 标签已经在做这件事。
- 这是所有招聘 AI 的天花板，Eightfold / LinkedIn 也解决不了 [3][4]。

### 场景 3：简历注水/夸大（技能词堆砌）的候选人被高估

**现象**：候选人把所有能沾边的技能都写进技能标签里，"精通 20 门技术"。纯关键词匹配会被刷高分。

**为什么会错**：关键词命中数不等于真实能力。"了解"和"精通"在关键词层面没有区别。

**缓解手段**：
- **特异性加权**（v4 已有）：越罕见/越长/越专业的技能词权重越高，通用短词权重低——防"Python/Java/C++ 都写"式的堆砌。
- **证据深度加权**：出现在工作经历描述里的 > 出现在项目里的 > 出现在技能标签里的。技能标签里写的词权重打 0.6 折。
- **一致性校验**：写了"精通 BEV"但工作经历里完全没提 BEV 相关项目/任务 → 降权。
- 这是相对容易做的一个增强，可以放在 P1。

### 场景 4：小众岗位 / 新岗位的本体覆盖不足

**现象**：某个刚出现的新岗位（如 AI Agent 工程师、Sora 视频生成），技能本体里还没有对应的概念和同义词。技能匹配退化为纯关键词，同义词/上下位推理全失效。

**为什么会错**：本体永远滞后于技术发展，尤其在快速变化的 AI 领域。

**缓解手段**：
- 本体维护机制：每季度更新一次，从最新 JD 中自动发现新词，LLM 辅助归类。
- 长尾词走 LLM 语义匹配（P2 阶段），不走本体——用 embedding 相似度兜底。
- 明确告知用户：新岗位前几批的评分准确率会低一些，等本体更新后会提升。

### 场景 5：转行 / 跨行业的候选人的可迁移性被低估

**现象**：候选人从互联网后端开发转嵌入式开发（C++/网络/系统编程是共通的，但 domain 完全不同）。模型会因为域不对而打低分，但实际上基础能力可迁移，上手快。

**为什么会错**：模型只看"做过什么"，不擅长判断"能不能迁移过来"。人类 TA 能判断"基础扎实的人转方向也快"，但模型很难。

**缓解手段**：
- **adjacent（相邻域）机制**（v4 已有）：如果 JD 的 adjacent 里包括"互联网后端"，那转行者分数会高一些。但 adjacent 需要 HR 手动配。
- **基础能力信号**：学历、公司层级、职业轨迹（是否一直在升级）、通用技能（C++/算法/数据结构）——这些跨域仍然有效的信号权重应该保持。
- 这是最难解决的问题之一，也是人类 recruiter 的核心价值——判断"潜力"和"可迁移性"。AI 在这一点上短期不可能替代人。

### 场景 6：项目/经历中的"参与"vs"主导"无法区分

**现象**：两个候选人都写了"参与 XX 项目"，一个是核心开发、另一个是打酱油的。模型从文本里看不出区别。

**为什么会错**：中文简历里"负责/参与/主导"的边界非常模糊，很多人都写"负责"。

**缓解手段**：
- 看职位升级轨迹（是否在该项目后升了职/加了薪）做弱信号。
- 看项目描述的详细程度、是否有量化结果（"性能提升 30%""日活 100 万"）——有量化的权重略高。
- 最终还是要靠面试验证，AI 评分只是初筛。

---

## 参考文献

> 编号对应正文中的引用标记。所有结论请追溯原文，不要依赖二手转述。

### 工业界 ATS / Sourcing 平台

[1] **Greenhouse Auto-Match Overview** — Greenhouse Help Center. https://support.greenhouse.io/hc/en-us/articles/25177493132699-Auto-Match-overview
    官方文档，说明了 1–4 档评分、must-have/nice-to-have 要求、AAR 自动推进。

[2] **Lever Candidate Insights / Fit Score** — Lever 产品页. https://www.lever.co/solutions/candidate-insights
    多 LLM 架构 + 加权汇总，定位为"排序辅助"，有人工反馈闭环。

[3] **LinkedIn Recruiter — Candidate Matching Signals** — LinkedIn Help Center. https://www.linkedin.com/help/recruiter
    官方确认的匹配信号：职位、技能（含背书）、经验、地点、教育、行业 + 行为信号。

[4] **Eightfold AI — Candidate Matching and Ranking / How Does Eightfold's AI Work?** — Eightfold.
    https://eightfold.ai/product/candidate-matching/ · https://eightfold.ai/blog/how-does-eightfolds-ai-work/
    深度学习 + 技能本体 + 表征学习，核心卖点是"基于技能而非头衔"的隐藏人才挖掘；Responsible AI 四大支柱。

[5] **Findem — AI Sourcing Copilot / Talent Data Cloud** — Findem. https://findem.ai/product
    10 万+ 属性的人才数据云，People Like Me 评分，基于属性的可解释性。

[6] **SmartRecruiters Talent Acquisition Suite** — SmartRecruiters. https://www.smartrecruiters.com
    AI Recruiter + Talia 聊天机器人做初筛，数字评分卡用于面试阶段。

[15] **Moka AI 大模型招聘解决方案** — Moka. https://www.mokahr.com/
    国内 ATS，AI 人岗匹配 + 推荐理由 + 自定义胜任力模型，定位为辅助（HR 复核）。

### 学术：PJF / Learning-to-Rank / 校准

[7] **Le et al. (2018)** — Enhancing Person-Job Fit for Talent Recruitment: An Ability-aware Neural Network Approach. SIGIR 2018.
    https://dl.acm.org/doi/10.1145/3209978.3209985
    PJFNN / APJFNN，显式能力 + 隐式能力双路建模，co-attention 机制，AUC 较基线提升 3-5%。

[8] **ConFit (2022)** — Contrastive Learning for Person-Job Fit. arXiv:2208.10676.
    https://arxiv.org/abs/2208.10676
    BERT 双塔 + 对比学习 + hard negative，缓解过拟合，中文数据集上 AUC 提升 2-4%。

[9] **Du et al. (2021)** — BERT-PJF: Pre-trained Language Model for Person-Job Fit.
    基于 BERT 的 PJF 二分类，长文本 JD 上优于 CNN/LSTM。

[10] **Zhu et al. (2022)** — ATBERT: Adversarial Training BERT for PJF. IEEE CSCWD 2022.
    https://doi.org/10.1109/CSCWD54268.2022.9776044
    对抗训练提升鲁棒性和 OOD 泛化。

[11] **CPT: Chinese Pre-trained Unbalanced Transformer** — 复旦 fastnlp. https://github.com/fastnlp/CPT
    中文预训练模型，encoder-decoder 非对称结构，PJF 场景可用其 encoder 做双塔。

[19] **Platt (1999)** — Probabilistic Outputs for Support Vector Machines.
    Platt scaling 参数化校准。
    *Zadrozny & Elkan (2001)* — Obtaining Calibrated Probability Estimates from Classifiers. ICML.
    *Niculescu-Mizil & Caruana (2005)* — Predicting Good Probabilities with Supervised Learning. ICML.
    校准方法对比：Platt vs Isotonic，小样本下 Platt 更稳。

[20] **scikit-learn — Probability Calibration** — sklearn 官方文档.
    ECE、可靠性图、交叉拟合校准。

[13] **Zhao et al. (2024)** — FSLPJ: Few-Shot Learning for PJF. arXiv:2401.03321.
    https://arxiv.org/abs/2401.03321
    少样本 PJF，Siamese BERT + 对比学习 + 元学习，5-20 样本下显著优于全量微调。

### BARS / 信效度 / 心理测量学

[16] **Smith & Kendall (1963)** — 行为锚定等级量表（BARS）奠基文献。
    *Flanagan (1954)* — Critical Incident Technique（关键事件法）.
    *Encyclopedia.com — Behaviorally Anchored Rating Scales*.
    https://www.encyclopedia.com/social-sciences/applied-and-social-sciences-magazines/behaviorally-anchored-rating-scales

[17] **Shrout & Fleiss (1979)** — Intraclass correlations: Uses in assessing rater reliability. Psychological Bulletin, 86(2), 420-428.
    ICC 经典文献，ICC(1,1) / ICC(2,1) / ICC(3,1) 等。
    *Cicchetti (1994)* — 信度阈值指南（<0.4 差 / 0.4-0.59 一般 / 0.6-0.74 好 / ≥0.75 优秀）。

[18] **Landis & Koch (1977)** — The measurement of observer agreement for categorical data. Biometrics, 33(1), 159-174.
    Cohen's kappa / Fleiss' kappa 阈值。

[21] **LinkedIn Engineering Blog (2023)** — Calibrating Candidate Ranking Models for Talent Search.
    LinkedIn 的候选人排序模型校准实践。

### 合规

[22] **Regulation (EU) 2024/1689（AI Act 官方文本）** — EUR-Lex.
    https://eur-lex.europa.eu/eli/reg/2024/1689/oj
    Annex III 高风险系统定义，Art.9-15 高风险系统义务，2026-08-02 生效。

[23] **European Commission — AI Act Overview** — https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai
    欧盟委员会官方解读。

[24] **NYC DCWP — Automated Employment Decision Tools** — NYC 消费者与工人保护局.
    https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page
    Local Law 144 of 2021 / AEDT 偏见审计要求 / 处罚标准。
    *DCWP Final Rules*: https://www.nyc.gov/assets/dca/downloads/pdf/about/aedt-final-rules.pdf

[26] **中华人民共和国个人信息保护法** — 全国人大官网.
    http://www.npc.gov.cn/npc/c30834/202108/d5c47c9f4b6544d9a0d0c652a0a0d16b.shtml
    第 24 条（自动化决策）。

[27] **中华人民共和国就业促进法** — 中国法律法规数据库.
    http://www.gov.cn/flfg/2007-08/30/content_732597.htm
    第 26、27、30 条（反歧视）。

### 技能本体 / 中文 NLP

[12] **ESCO Portal** — 欧盟技能/资质/职业分类.
    https://esco.ec.europa.eu/
    2954 个职业、13500+ 技能、27 种语言，SKOS/RDF 格式，开放 API。

[14] **O*NET Center** — 美国职业信息网.
    https://www.onetcenter.org/
    923 个细粒度职业、277 项标准技能，API + 数据库下载。

[25] **SkillNER** — 技能抽取 + 标准化工具，基于 ESCO. https://skillner.site/
    *SkillSynNet* (arXiv:2311.06302) — ESCO 衍生技能同义词网络。

### 中文招聘 NLP

[28] **Liu et al. (2021)** — Talent Recruitment: A Survey of Data-Driven Methods. IEEE TKDE.
    招聘领域数据驱动方法综述，覆盖简历解析、匹配、人才流动预测。

---

> 文档版本：v5.0（方案稿） · 编写于 2026-07-31
> 下一步：评审 → 确认 P0 范围 → 启动开发
