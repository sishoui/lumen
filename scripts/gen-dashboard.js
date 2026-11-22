// scripts/gen-dashboard.js — 生成 dashboard/index.html 静态工作台
// 收集: git log + 测试结果 + 契约状态 + git-truck 链接，渲染成一个中文 HTML 页
// 用法: node scripts/gen-dashboard.js  （在 bt-light/ 下）

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dashboard');
fs.mkdirSync(OUT, { recursive: true });

// 1. git log (最近 30 条)
let gitLog = '';
try {
  gitLog = execSync('git -C "' + ROOT + '" log --pretty=format:"%h|%ad|%s" --date=short -30', { encoding: 'utf8' });
} catch (e) { gitLog = ''; }

const commits = gitLog.split('\n').filter(Boolean).map(line => {
  const [hash, date, ...rest] = line.split('|');
  return { hash, date, msg: rest.join('|') };
});

// 2. 跑测试，抓 pass/fail
let testOut = '';
let testsPass = 0, testsFail = 0;
try {
  testOut = execSync('node test/protocol.test.js && node test/contract.test.js', {
    cwd: path.join(ROOT, 'miniprogram'),
    encoding: 'utf8',
    timeout: 60000
  });
  const m = testOut.match(/(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (m) { testsPass += +m[1]; testsFail += +m[2]; }
  // contract test 也单独再抓一次（两个测试各自汇总）
  const m2 = testOut.match(/(\d+)\s+passed,\s*(\d+)\s+failed/g);
  if (m2) {
    testsPass = 0; testsFail = 0;
    m2.forEach(x => { const mm = x.match(/(\d+) passed, (\d+) failed/); if (mm) { testsPass += +mm[1]; testsFail += +mm[2]; } });
  }
} catch (e) {
  testOut = (e.stdout || '') + (e.stderr || '');
  const m = testOut.match(/(\d+)\s+passed,\s*(\d+)\s+failed/g);
  if (m) { m.forEach(x => { const mm = x.match(/(\d+) passed, (\d+) failed/); if (mm) { testsPass += +mm[1]; testsFail += +mm[2]; } }); }
}

// 3. 契约文件
let contract = null;
try { contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contract.json'), 'utf8')); } catch (e) {}

// 4. 渲染 HTML
const contractRows = contract ? Object.entries(contract).filter(([k]) => !k.startsWith('_')).map(([k, v]) => {
  if (typeof v === 'object') {
    const sub = Object.entries(v).map(([ck, cv]) => `${ck} → ${cv}`).join('；');
    return `<tr><td>${k}</td><td>${sub}</td></tr>`;
  }
  return `<tr><td>${k}</td><td>${v}</td></tr>`;
}).join('') : '<tr><td colspan="2">未找到 docs/contract.json</td></tr>';

const commitRows = commits.length ? commits.map(c =>
  `<tr><td><code>${c.hash}</code></td><td>${c.date}</td><td>${c.msg}</td></tr>`
).join('') : '<tr><td colspan="3">暂无提交</td></tr>';

const testPassClass = testsFail === 0 ? 'pass' : 'fail';
const total = testsPass + testsFail;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>bt-light 项目工作台</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #121212; color: #eee; }
  header { background: #1e1e1e; padding: 16px 24px; border-bottom: 1px solid #333; }
  header h1 { margin: 0; font-size: 20px; }
  header .sub { color: #999; font-size: 13px; margin-top: 4px; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 16px; }
  .card .num { font-size: 32px; font-weight: 600; }
  .card .label { color: #999; font-size: 13px; margin-top: 4px; }
  .card.pass .num { color: #4ade80; }
  .card.fail .num { color: #f87171; }
  .card a { color: #60a5fa; text-decoration: none; }
  h2 { font-size: 16px; margin: 28px 0 12px; color: #ccc; }
  table { width: 100%; border-collapse: collapse; background: #1e1e1e; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #333; font-size: 14px; }
  th { background: #252525; color: #aaa; font-weight: 500; }
  tr:last-child td { border-bottom: none; }
  code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .toolbar { margin: 20px 0; display: flex; gap: 10px; flex-wrap: wrap; }
  .toolbar a, .toolbar button { background: #2a2a2a; color: #eee; border: 1px solid #444; padding: 8px 14px; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 13px; }
  .toolbar a:hover, .toolbar button:hover { background: #333; }
  footer { color: #666; font-size: 12px; text-align: center; padding: 24px; }
  .empty { color: #666; padding: 20px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>bt-light 项目工作台</h1>
  <div class="sub">最后一次生成: ${new Date().toLocaleString('zh-CN')} · 数据来源: git log + npm test + docs/contract.json</div>
</header>
<div class="wrap">
  <div class="grid">
    <div class="card ${testPassClass}">
      <div class="num">${testsPass}</div>
      <div class="label">测试通过 (${total} 项)</div>
    </div>
    <div class="card ${testsFail > 0 ? 'fail' : 'pass'}">
      <div class="num">${testsFail}</div>
      <div class="label">测试失败</div>
    </div>
    <div class="card">
      <div class="num">${commits.length}</div>
      <div class="label">git 提交数 (近 30 条)</div>
    </div>
  </div>

  <div class="toolbar">
    <a href="http://localhost:3001/view?path=${encodeURIComponent(ROOT).replace(/\\/g, '%5C').replace(/:/g, '%3A')}" target="_blank">① 打开 git-truck 可视化</a>
    <button onclick="location.reload()">② 刷新本页</button>
    <a href="file:///${ROOT.replace(/\\/g, '/')}/CHANGELOG.md" target="_blank">③ 查看 CHANGELOG 时间线</a>
    <button onclick="navigator.clipboard.writeText('cd ${ROOT.replace(/\\/g, '/')} && npx -y git-truck --headless').then(()=>alert('已复制 git-truck 启动命令'))">④ 复制 git-truck 启动命令</button>
  </div>

  <h2>BLE 契约（docs/contract.json）</h2>
  <table>
    <tr><th>项</th><th>值</th></tr>
    ${contractRows}
  </table>

  <h2>最近改动（git log）</h2>
  <table>
    <tr><th>hash</th><th>日期</th><th>说明</th></tr>
    ${commitRows}
  </table>

  <h2>测试输出摘要</h2>
  <pre style="background:#1e1e1e;padding:16px;border-radius:8px;overflow:auto;font-size:12px;color:#bbb;">${testOut.replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(-1500)}</pre>
</div>
<footer>bt-light dashboard · 由 scripts/gen-dashboard.js 自动生成 · 不要手动编辑</footer>
</body>
</html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('dashboard/index.html 已生成');
console.log('  测试通过:', testsPass, ' 失败:', testsFail);
console.log('  git 提交数:', commits.length);
console.log('  在浏览器打开:', path.join(OUT, 'index.html'));