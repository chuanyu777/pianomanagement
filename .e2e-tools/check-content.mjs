/** 校验页面把三个月的测试数据真实渲染出来了（不只 HTTP 200）。 */
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Users\\86188\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext()).newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'load' });
await page.fill('input[autocomplete="username"]', 'zhoucc');
await page.fill('input[autocomplete="current-password"]', 'Zhoucc123456');
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);

const checks = [
  ['经营总览-当月课时消费', '/', ['300.00', '课时消费']],
  ['收支管理-10月', '/finance', ['300.00', '27.00', '退费手续费']],
  ['工资表-9月', '/payroll', ['3236.00', '2836.00', '张老师']],
  ['经营分析-8月排行', '/analytics', ['1250.00', '张老师']],
  ['学生台账', '/ledger', ['选择学生']],
  ['学生档案', '/students', ['小明', '小红', '小刚', '小丽', '小军', '小强']],
  ['老师档案', '/teachers', ['张老师', '李老师']],
  ['账号管理', '/users', ['zhang01', 'zhoucc']],
];

let bad = 0;
for (const [name, path, expects] of checks) {
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const body = ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ');
  const missing = expects.filter((e) => !body.includes(e));
  // 需要切月的页面：在月份输入里填 2026-09 再取一次
  if (missing.length && (path === '/finance' || path === '/payroll' || path === '/analytics')) {
    const dp = await page.$('input[placeholder]');
    if (dp) {
      await dp.fill('2026-09');
      await dp.press('Enter');
      await page.waitForTimeout(2500);
    }
    const b2 = ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ');
    for (const e of [...missing]) if (b2.includes(e)) missing.splice(missing.indexOf(e), 1);
  }
  if (missing.length) {
    bad += 1;
    console.log(`[FAIL] ${name}  缺少: ${missing.join(' | ')}`);
    console.log(`       body 前 200 字: ${body.slice(0, 200)}`);
  } else {
    console.log(`[OK]   ${name}`);
  }
}

console.log(bad ? `\n${bad} 项未通过` : '\n页面内容全部符合预期');
await browser.close();
process.exit(bad ? 1 : 0);
