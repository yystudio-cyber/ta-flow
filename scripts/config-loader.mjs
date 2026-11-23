/**
 * 配置加载器 —— 把「用户的业务数据」和「代码」彻底分开。
 *
 * 这个仓库不带任何真实岗位、简历、组织架构或账号信息。
 * 你需要自己的东西放进 config/ 下：
 *   config/jd-config.json   岗位库（评分用的 JD 定义）
 *   config/workflow.json    平台 / 飞书租户 / Excel 台账 / 语料目录
 *
 * 两个文件都提供了 .example.json 模板，复制改名即可。
 * config/*.json 已在 .gitignore 里排除，不会被误提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pick(userFile, exampleFile) {
  if (fs.existsSync(userFile)) return { file: userFile, data: readJson(userFile), isExample: false };
  if (fs.existsSync(exampleFile)) return { file: exampleFile, data: readJson(exampleFile), isExample: true };
  return null;
}

/** 读岗位库配置。返回 { jobs: [...], file, isExample } */
export function loadJdConfig() {
  const r = pick(path.join(CONFIG_DIR, 'jd-config.json'), path.join(CONFIG_DIR, 'jd-config.example.json'));
  if (!r) throw new Error('找不到 config/jd-config.json，也没有 .example.json 模板。');
  if (r.isExample) {
    console.warn('[config] ⚠ 正在使用示例岗位库（jd-config.example.json）。');
    console.warn('[config]   想要自己的岗位：复制成 config/jd-config.json 再改。');
  }
  const data = r.data;
  const jobs = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [data];
  return { jobs, file: r.file, isExample: r.isExample };
}

/** 读工作流配置。缺失时回落到示例。 */
export function loadWorkflowConfig() {
  const r = pick(path.join(CONFIG_DIR, 'workflow.json'), path.join(CONFIG_DIR, 'workflow.example.json'));
  if (!r) throw new Error('找不到 config/workflow.json，也没有 .example.json 模板。');
  return { config: r.data, file: r.file, isExample: r.isExample };
}

/** 飞书租户的完整 origin，例如 https://example.feishu.cn */
export function feishuOrigin(cfg) {
  const sub = (cfg?.feishu?.tenantSubdomain || 'example').trim();
  return `https://${sub}.feishu.cn`;
}
