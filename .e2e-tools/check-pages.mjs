/**
 * 逐页验收脚本（无头 Chrome）。
 * 用法：node check-pages.mjs [前端地址]
 * 前置：后端已启动、数据库已迁移、已存在账号 apitest / Apitest123456（OWNER）。
 */
import { chromium } from 'playwright-core';

const CHROME =
  'C:\\Users\\86188\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = process.argv[2] ?? 'http://localhost:5173';
const USER = 'zhoucc';
const PASS = 'Zhoucc123456';

const PAGES = [
  ['经营总览', '/'],
  ['收支管理', '/finance'],
  ['工资表', '/payroll'],
  ['经营分析', '/analytics'],
  ['风险提醒', '/risks'],
  ['初始化向导', '/onboarding'],
  ['排课与上课', '/lessons'],
  ['学生台账', '/ledger'],
  ['学生档案', '/students'],
  ['报名与单价', '/enrollments'],
  ['课程类型', '/course-types'],
  ['老师档案', '/teachers'],
  ['收支项目', '/items'],
  ['账号管理', '/users'],
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const pageErrorStacks = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
});
page.on('pageerror', (err) => {
  consoleErrors.push(`PAGEERROR ${err.message.slice(0, 300)}`);
  pageErrorStacks.push(String(err.stack ?? '').split('\n').slice(0, 10).join('\n'));
});

// 登录
await page.goto(`${BASE}/login`, { waitUntil: 'load' });
await page.fill('input[autocomplete="username"]', USER);
await page.fill('input[autocomplete="current-password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);
console.log(`登录后地址: ${page.url()}`);

const report = [];
for (const [name, path] of PAGES) {
  consoleErrors.length = 0;
  pageErrorStacks.length = 0;
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await page.waitForTimeout(2200);
  } catch (error) {
    report.push({ name, path, verdict: '导航失败', detail: String(error).slice(0, 200) });
    continue;
  }
  const body = (await page.textContent('body')) ?? '';
  const text = body.replace(/\s+/g, ' ').trim();
  const crashed = text.includes('页面出错了');
  const blank = text.length < 30;
  let verdict = 'OK';
  if (crashed) verdict = `崩溃: ${text.match(/页面出错了([\s\S]{0,160})/)?.[1]?.trim() ?? ''}`;
  else if (blank) verdict = `空白: body 长度 ${text.length}`;
  else if (text.includes('待实现')) verdict = '还是占位页';
  report.push({
    name,
    path,
    verdict,
    bodyLength: text.length,
    consoleErrors: [...consoleErrors],
    stacks: [...pageErrorStacks],
  });
}

console.log('\n===== 逐页结果 =====');
for (const row of report) {
  console.log(`\n【${row.name}】${row.path} → ${row.verdict}`);
  if (row.consoleErrors?.length) {
    for (const err of row.consoleErrors.slice(0, 3)) console.log(`   console: ${err}`);
  }
  if (row.stacks?.length && row.verdict !== 'OK') {
    console.log('   ---- 完整堆栈 ----');
    console.log(row.stacks[0]);
  }
}

const bad = report.filter((row) => row.verdict !== 'OK');
console.log(`\n===== 汇总：${report.length - bad.length}/${report.length} 页 OK =====`);
await browser.close();
process.exit(bad.length > 0 ? 1 : 0);
