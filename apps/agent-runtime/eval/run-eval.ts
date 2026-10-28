import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatOpenAI } from '@langchain/openai';
import { createIntentParser, type IntentDiagnostic } from '../src/graph/intent-parser.js';

type EvalCase = { id: string; message: string; expect: string };
type Outcome = {
  id: string;
  message: string;
  expected: string;
  actual: string;
  mode: string;
  passed: boolean;
  source: string;
  ruleOperation: string | null;
  attempts: number;
  detail?: string;
};

function loadEnv(): void {
  if (process.env['AI_API_KEY']) return;
  const file = resolve(import.meta.dirname, '../../../.env');
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
      if (!match) continue;
      const [, key, value] = match;
      if (key && value !== undefined && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // ignore; the run will fail with a clear message below
  }
}

function judge(expected: string, actualOperation: string | null, mode: string): boolean {
  if (expected === 'clarify') return mode === 'clarify' || actualOperation === null;
  return actualOperation === expected;
}

loadEnv();
const apiKey = process.env['AI_API_KEY'];
if (!apiKey) {
  console.error('缺少 AI_API_KEY，无法运行评估。请在根目录 .env 中配置。');
  process.exit(1);
}

const cases = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8')) as EvalCase[];
const model = new ChatOpenAI({
  model: process.env['AI_MODEL'] || 'deepseek-chat',
  apiKey,
  maxTokens: 400,
  temperature: 0,
  maxRetries: 0,
  timeout: 30_000,
  configuration: { baseURL: 'https://api.deepseek.com' },
});

const diagnostics: IntentDiagnostic[] = [];
const parser = createIntentParser(model, {
  shadowRules: true,
  emergencyRuleFallback: false,
  onDiagnostic: (item) => diagnostics.push(item),
});

const outcomes: Outcome[] = [];
for (const [index, item] of cases.entries()) {
  const ruleBefore = diagnostics.length;
  const result = await parser({ businessDate: '2026-10-28', task: {}, userMessage: item.message });
  const ruleOps = diagnostics
    .slice(ruleBefore)
    .filter((d) => d.event === 'shadow-comparison')
    .map((d) => d.ruleOperation ?? null);

  if (result.kind === 'parsed') {
    const actual = result.intent.operation;
    outcomes.push({
      id: item.id,
      message: item.message,
      expected: item.expect,
      actual: actual ?? '(null)',
      mode: result.intent.mode,
      passed: judge(item.expect, actual, result.intent.mode),
      source: result.source,
      ruleOperation: ruleOps[0] ?? null,
      attempts: result.attempts,
    });
  } else {
    outcomes.push({
      id: item.id,
      message: item.message,
      expected: item.expect,
      actual: result.kind,
      mode: '-',
      passed: item.expect === 'clarify' && result.kind === 'unparsable',
      source: 'none',
      ruleOperation: ruleOps[0] ?? null,
      attempts: result.kind === 'unparsable' ? result.attempts : 0,
      detail: result.detail,
    });
  }
  process.stderr.write(`[${index + 1}/${cases.length}] ${item.id} ${outcomes.at(-1)?.passed ? 'PASS' : 'FAIL'}\n`);
}

const total = outcomes.length;
const passed = outcomes.filter((o) => o.passed).length;
const rate = ((passed / total) * 100).toFixed(1);
const modelAttempts = outcomes.reduce((sum, o) => sum + o.attempts, 0);
const retried = outcomes.filter((o) => o.attempts > 1).length;
const compared = outcomes.filter((o) => o.ruleOperation !== null);
const agreed = compared.filter((o) => o.ruleOperation === o.actual);

const byExpected = new Map<string, { total: number; passed: number }>();
for (const outcome of outcomes) {
  const bucket = byExpected.get(outcome.expected) ?? { total: 0, passed: 0 };
  bucket.total += 1;
  if (outcome.passed) bucket.passed += 1;
  byExpected.set(outcome.expected, bucket);
}

const failures = outcomes.filter((o) => !o.passed);
const lines: string[] = [];
lines.push('# Agent 意图理解评估报告');
lines.push('');
lines.push(`运行时间：${new Date().toISOString()}`);
lines.push(`模型：${process.env['AI_MODEL'] || 'deepseek-chat'}　语料：${total} 条`);
lines.push('');
lines.push('## 总览');
lines.push('');
lines.push('| 指标 | 数值 |');
lines.push('|---|---|');
lines.push(`| 通过 | ${passed} / ${total}（${rate}%） |`);
lines.push(`| 模型调用总次数 | ${modelAttempts}（含纠错重试） |`);
lines.push(`| 触发纠错重试的用例 | ${retried} |`);
lines.push(`| 与确定性规则可对照的用例 | ${compared.length} |`);
lines.push(`| 其中模型与规则一致 | ${agreed.length}（${compared.length ? ((agreed.length / compared.length) * 100).toFixed(1) : '0'}%） |`);
lines.push('');
lines.push('## 按期望能力分组');
lines.push('');
lines.push('| 期望操作 | 通过 / 总数 | 通过率 |');
lines.push('|---|---|---|');
for (const [operation, bucket] of [...byExpected.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| ${operation} | ${bucket.passed} / ${bucket.total} | ${((bucket.passed / bucket.total) * 100).toFixed(0)}% |`);
}
lines.push('');
lines.push('## 未通过明细');
lines.push('');
if (failures.length === 0) {
  lines.push('全部通过。');
} else {
  lines.push('| 用例 | 原话 | 期望 | 实际 | mode | 规则判定 |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of failures) {
    lines.push(`| ${f.id} | ${f.message} | ${f.expected} | ${f.actual} | ${f.mode} | ${f.ruleOperation ?? '无'} |`);
  }
}
lines.push('');
lines.push('## 规则与模型分歧（供参考）');
lines.push('');
const diverged = compared.filter((o) => o.ruleOperation !== o.actual);
if (diverged.length === 0) {
  lines.push('无分歧。');
} else {
  lines.push('| 用例 | 原话 | 模型 | 规则 |');
  lines.push('|---|---|---|---|');
  for (const d of diverged) {
    lines.push(`| ${d.id} | ${d.message} | ${d.actual} | ${d.ruleOperation} |`);
  }
}

const report = lines.join('\n');
const reportPath = resolve(import.meta.dirname, 'last-report.md');
writeFileSync(reportPath, `${report}\n`, 'utf8');
process.stdout.write(`${report}\n\n报告已写入 ${reportPath}\n`);
process.exit(passed / total >= 0.95 ? 0 : 1);
