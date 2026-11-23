const fs = require('fs');
const path = require('path');

const toolsDir = 'C://Users//you/Desktop/AI/TA流程优化/_tool_scratch';
const expectedId = 'feishu-requirement-generator';

const files = fs.readdirSync(toolsDir);
console.log('files:', files);

const manifestPath = path.join(toolsDir, expectedId + '.tool.json');
const raw = fs.readFileSync(manifestPath, 'utf-8');
const manifest = JSON.parse(raw);
console.log('\nmanifest id:', manifest.id);
console.log('manifest name:', manifest.name);
console.log('manifest entry:', manifest.entry);
console.log('manifest matches:', manifest.matches);
console.log('manifest permissions:', manifest.permissions);
console.log('manifest builtin:', manifest.builtin);

// 校验 entry 存在
const entryPath = path.join(toolsDir, manifest.entry);
const exists = fs.existsSync(entryPath);
console.log('\nentry script exists:', exists);
console.log('entry script size:', exists ? fs.statSync(entryPath).size : 'N/A');

// 校验 content.js 顶部不是严格模式问题（基本语法）
try {
  // 用 Function 构造器做语法检查（不执行）
  new Function(fs.readFileSync(entryPath, 'utf-8'));
  console.log('content.js syntax: OK');
} catch (e) {
  console.error('content.js syntax ERROR:', e.message);
}

// 校验 manifest 必要字段
const required = ['id', 'name', 'matches', 'entry'];
const missing = required.filter(k => !manifest[k]);
console.log('\nrequired fields ok:', missing.length === 0 ? 'YES' : 'MISSING: ' + missing.join(','));
