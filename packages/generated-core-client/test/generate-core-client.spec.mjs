import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInputSpec,
  missingSpecMessage,
  parseArgs,
} from '../scripts/generate-core-client.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Core OpenAPI generator tool', () => {
  it('uses the package-local default input and generated output', () => {
    const parsed = parseArgs([]);

    expect(parsed.input).toMatch(/packages[\\/]generated-core-client[\\/]openapi\.json$/);
    expect(parsed.output).toMatch(/packages[\\/]generated-core-client[\\/]src[\\/]generated[\\/]core-api\.ts$/);
  });

  it('accepts explicit paths relative to the package root', () => {
    const parsed = parseArgs(['--input', '../../apps/core-api/openapi.json', '--output', 'src/generated/custom.ts']);

    expect(parsed.input).toMatch(/apps[\\/]core-api[\\/]openapi\.json$/);
    expect(parsed.output).toMatch(/packages[\\/]generated-core-client[\\/]src[\\/]generated[\\/]custom\.ts$/);
  });

  it('rejects an unknown option before touching the filesystem', () => {
    expect(() => parseArgs(['--schema', 'openapi.json'])).toThrow('未知参数：--schema');
  });

  it('reports the required upstream export when the spec is missing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'piano-generated-client-'));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, 'missing.json');

    await expect(assertInputSpec(inputPath)).rejects.toThrow(missingSpecMessage(inputPath));
  });

  it('accepts a readable spec without interpreting its domain content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'piano-generated-client-'));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, 'openapi.json');
    await mkdir(directory, { recursive: true });
    await writeFile(inputPath, '{"openapi":"3.1.0"}', 'utf8');

    await expect(assertInputSpec(inputPath)).resolves.toBeUndefined();
  });
});
