// 将 _tool_scratch 里的工具文件拷贝到 TA 平台 tools 目录
const fs = require('fs');
const path = require('path');

const TOOL_ID = 'feishu-requirement-generator';
const SRC_DIR = path.resolve(__dirname);
const DST_DIR = 'C://Users//you/Desktop/AI/TA Flow/tools/' + TOOL_ID;

if (!fs.existsSync(DST_DIR)) {
  fs.mkdirSync(DST_DIR, { recursive: true });
  console.log('created:', DST_DIR);
}

const files = [
  TOOL_ID + '.tool.json',
  'content.js',
];

// ⚠️ 降级护栏（2026-07-29 加）。
// 本目录是 2026-07-24 真机校准时留下的【历史快照】（v1.0.0，28KB），
// 而生产目录早已迭代到 v3.x（78KB，含飞书 Formily 表单校准、UD 下拉/树点选回读校验、
// 直接赋值主路径修 3% 脏字、以及多轮对抗审查修的假成功问题）。
// 原来这里是无条件 fs.copyFileSync —— 谁手滑跑一次，生产工具就被整体降级回 v2 之前，
// 所有修复连同 manifest 一起没掉，而且不会有任何提示。
// 现在：只允许同版本或升级；要覆盖更新的版本必须显式加 --force。
function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, TOOL_ID + '.tool.json'), 'utf-8')).version || '0.0.0';
  } catch (e) { return null; }
}
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const srcVer = readVersion(SRC_DIR);
const dstVer = readVersion(DST_DIR);
const force = process.argv.includes('--force');
if (srcVer && dstVer && cmpVer(srcVer, dstVer) < 0 && !force) {
  console.error('\n✗ 拒绝执行：这会把生产工具降级。');
  console.error('  本目录（历史校准快照）版本：' + srcVer);
  console.error('  生产目录当前版本：        ' + dstVer);
  console.error('  生产版本更新，覆盖会丢失后续所有修复。');
  console.error('  确实要覆盖请显式加 --force（请先确认你真的想回退）。\n');
  process.exit(1);
}

for (const f of files) {
  const src = path.join(SRC_DIR, f);
  const dst = path.join(DST_DIR, f);
  fs.copyFileSync(src, dst);
  const stat = fs.statSync(dst);
  console.log('installed:', f, '(', stat.size, 'bytes )');
}

// 校验能正确识别
console.log('\n=== Verification ===');
const manifest = JSON.parse(fs.readFileSync(path.join(DST_DIR, TOOL_ID + '.tool.json'), 'utf-8'));
console.log('tool id:', manifest.id);
console.log('tool name:', manifest.name);
console.log('builtin:', manifest.builtin);
console.log('matches:', manifest.matches.join(', '));
console.log('permissions:', manifest.permissions.join(', '));
console.log('entry:', manifest.entry, '-> exists:', fs.existsSync(path.join(DST_DIR, manifest.entry)));
console.log('\nAll files installed successfully.');
