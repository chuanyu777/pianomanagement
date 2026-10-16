import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const defaultInput = path.join(packageRoot, 'openapi.json');
export const defaultOutput = path.join(packageRoot, 'src', 'generated', 'core-api.ts');

export function parseArgs(args) {
  const parsed = { input: defaultInput, output: defaultOutput, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--input' || argument === '-i') {
      parsed.input = path.resolve(packageRoot, requireValue(args, ++index, argument));
      continue;
    }
    if (argument === '--output' || argument === '-o') {
      parsed.output = path.resolve(packageRoot, requireValue(args, ++index, argument));
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }

  return parsed;
}

function requireValue(args, index, argument) {
  const value = args[index];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${argument} 需要一个路径参数`);
  }
  return value;
}

export function missingSpecMessage(inputPath) {
  return [
    `Core OpenAPI 规范未找到：${inputPath}`,
    '请先由 apps/core-api 导出 openapi.json，再执行本生成命令。',
    '本包不内置演示 schema，也不会根据旧代码猜测领域 DTO 或枚举。',
  ].join('\n');
}

export async function assertInputSpec(inputPath) {
  try {
    await access(inputPath, constants.R_OK);
  } catch {
    throw new Error(missingSpecMessage(inputPath));
  }
}

async function runOpenApiTypescript(inputPath, outputPath) {
  const command = process.platform === 'win32' ? 'openapi-typescript.cmd' : 'openapi-typescript';
  await new Promise((resolve, reject) => {
    const child = spawn(command, [inputPath, '-o', outputPath], {
      cwd: packageRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`openapi-typescript 生成失败（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`));
    });
  });
}

export async function generateCoreClient({ inputPath = defaultInput, outputPath = defaultOutput } = {}) {
  await assertInputSpec(inputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runOpenApiTypescript(inputPath, outputPath);
  return { inputPath, outputPath };
}

export function helpText() {
  return [
    '用法：npm run generate -- [--input <openapi.json>] [--output <generated.ts>]',
    '',
    `默认输入：${path.relative(packageRoot, defaultInput)}`,
    `默认输出：${path.relative(packageRoot, defaultOutput)}`,
    '',
    '输入规范必须由 Core 导出；本包不会生成或维护领域 schema。',
  ].join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  await generateCoreClient({ inputPath: parsed.input, outputPath: parsed.output });
  process.stdout.write(`已生成：${path.relative(packageRoot, parsed.output)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
