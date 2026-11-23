# 猎聘人才库 FTS5 真机闭环 · 重启核验步骤

> 阶段B 稳定与安全产出。目的：证明 FTS5 影子表在「重启后」仍闭环可用——
> 迁移建表 → 加密就绪后回填 → 查询走索引 / 回退 LIKE 三段不脱节。

## 背景：为什么需要这份核验

猎聘人才库主表 `liepin_talents` 的检索列（name/position/company/city/experience/degree）是**密文**，
SQL LIKE 索引不到。阶段5② 引入 FTS5 影子表 `liepin_talents_fts`（trigram tokenizer）存明文加速检索。

难点在启动时序：迁移（`migrateStep`）跑在加密初始化**之前**，此刻主表检索列是密文、无法解密灌明文。
因此拆成两步——迁移只建表，回填推迟到加密就绪后。这份文档核验这个时序在真机上不断裂。

## 闭环三段（代码锚点）

| 段 | 代码位置 | 做什么 |
|---|---|---|
| ① 建表 | `db.ts` `migrateStep` case 5→6（~1004 行）/ `createSchema`（~729 行） | `CREATE VIRTUAL TABLE IF NOT EXISTS liepin_talents_fts USING fts5(...)`，**只建表不回填** |
| ② 回填 | `db.ts` `reindexLiepinTalentsFts()`（~1315 行） | 启动时加密就绪后幂等执行；`ftsN >= mainN` 则秒过，否则解密主表灌明文进影子表 |
| ② 触发 | `index.ts` bootStep「猎聘人才库全文索引」（~406 行） | 顺序：`initDatabase` → `initEncryptionFromSettings` → `reindexLiepinTalentsFts` |
| ③ 查询 | `db.ts` `listLiepinTalents`（~1511 行）/ `liepinFtsMatchIds`（~1488 行） | q≥3 字符走 FTS MATCH；<3 字符 / FTS 表缺失 / MATCH 异常 → 回退解密后内存 LIKE |

幂等保证：`upsertLiepinTalent` 每次写主表都同步 `upsertLiepinFts`（先删后插）；`reindex` 用 `ftsN>=mainN` 短路，
十万级也只跑一次（之后增量维护）。

## 真机核验步骤

### 前置：准备一个有数据的库

1. 正常启动 App，跑一次猎聘 RPA 收几条候选人入 `liepin_talents`（确保主表 ≥3 行）。
2. 确认设置里「数据加密」已开启且实际状态为「生效中」（否则影子表灌的是明文，测不到密文闭环）。

### 核验 1：重启后 FTS 行数 == 主表行数（回填闭环）

1. 退出 App（正常退出，让 `flush` 落盘）。
2. 用任意 SQLite 工具打开数据目录下的 `ta-platform.db`（数据目录见设置页「数据管理」），执行：
   ```sql
   SELECT (SELECT COUNT(*) FROM liepin_talents)       AS main_n,
          (SELECT COUNT(*) FROM liepin_talents_fts)   AS fts_n;
   ```
   预期：`main_n == fts_n`（且都 > 0）。若 `fts_n < main_n`，说明上次回填没跑完——重启 App 一次再查应补齐。
3. **破坏性验证**：手动 `DELETE FROM liepin_talents_fts;`（清空影子表，模拟回填丢失），退出。
4. 重启 App，再查同样的 SQL。预期：`fts_n` 回到 == `main_n`（启动回填幂等补齐）。

### 核验 2：长词（≥3 字符）走 FTS 索引

1. App 启动后进猎聘人才库子页，在搜索框输入一个**存在于某候选人 company/name 里的 3 字以上词**（如任意一个真实公司名）。
2. 预期：能搜到该候选人，耗时正常（FTS 命中）。
3. 控制台/日志确认无 `liepin FTS MATCH 失败，回退内存 LIKE` warning——有则说明 FTS 没走通，查影子表是否建好。

### 核验 3：两字词回退 LIKE（trigram 边界）

1. 搜索框输入一个**两字词**（如「北京」「前端」）。
2. 预期：仍能搜到匹配的候选人（`liepinFtsMatchIds` 对 <3 字符返回 null → 走内存 LIKE 回退，正确性零损失）。
3. 这是设计行为，不是 bug——trigram tokenizer 对 <3 字符必无命中，回退 LIKE 保证不漏。

### 核验 4：特殊字符不炸查询（净化）

1. 搜索框输入含 FTS5 操作符的串：`"测试" * : ()`（引号/星号/冒号/括号）。
2. 预期：不报 `FTS5 syntax error`，要么命中要么空集，**绝不崩查询**。`sanitizeFtsMatch` 把整段包成 phrase query 并转义内部双引号。

### 核验 5：清空数据后影子表同步清空

1. 设置页「数据管理」→「清空所有数据」（二次确认）。
2. 打开 db 执行：
   ```sql
   SELECT COUNT(*) FROM liepin_talents;       -- 0
   SELECT COUNT(*) FROM liepin_talents_fts;   -- 0（clearAllData 已同步清影子表）
   ```
   预期：两个都为 0。若 fts 仍有残留行，是 `clearAllData` 没清影子表（本阶段已补此行，若复现说明回退）。

## 故障排查

| 现象 | 排查 |
|---|---|
| `fts_n` 始终为 0 但 `main_n > 0` | 看启动日志有没有「猎聘人才库全文索引」bootStep 失败；或加密实际状态是「未生效·明文写入」（`reindex` 走解密层读到密文当明文灌入，检索不到） |
| 搜索全走 LIKE、从不走 FTS | 确认查询词 ≥3 字符；`liepinFtsMatchIds` 返回 null 的三个原因：表缺失 / <3 字符 / MATCH 异常——查控制台 warning |
| `FTS5 syntax error` 报错 | `sanitizeFtsMatch` 未覆盖的边界——记录输入串反馈，补净化规则 |

## 不变量（回归测试可断言）

1. `SELECT COUNT(*) FROM liepin_talents_fts` == `SELECT COUNT(*) FROM liepin_talents`（回填后）
2. `ftsN >= mainN` 时 `reindexLiepinTalentsFts()` 秒过返回 `skipped:true`（不重灌）
3. 任一 `upsertLiepinTalent` 后，该 `res_id` 在影子表存在且仅一行（先删后插幂等）
4. `clearAllData()` 后主表与影子表同为 0
