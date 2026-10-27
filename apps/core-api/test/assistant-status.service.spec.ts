import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantStatusService } from '../src/modules/assistant-status/assistant-status.service.js';

const checkedAt = new Date('2026-10-16T01:02:03.000Z');
const originalAgentRuntimeUrl = process.env['AGENT_RUNTIME_URL'];

describe('AssistantStatusService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalAgentRuntimeUrl === undefined) delete process.env['AGENT_RUNTIME_URL'];
    else process.env['AGENT_RUNTIME_URL'] = originalAgentRuntimeUrl;
  });

  it('reports Core and Agent Runtime availability without business data', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', service: 'agent-runtime', modelAvailable: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = new AssistantStatusService(prisma as never);

    await expect(
      service.getStatus({
        agentRuntimeUrl: 'http://agent-runtime.test',
        fetchImpl,
        now: () => checkedAt,
      }),
    ).resolves.toEqual({
      available: true,
      core: { available: true },
      agentRuntime: { available: true },
      checkedAt: checkedAt.toISOString(),
      message: 'AI 助手已连接',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://agent-runtime.test/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reports AI unavailable when the runtime is healthy but the model is disabled', async () => {
    const service = new AssistantStatusService({ $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) } as never);
    const result = await service.getStatus({ agentRuntimeUrl: 'http://agent-runtime.test', fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', service: 'agent-runtime', modelAvailable: false }), { status: 200 })), now: () => checkedAt });
    expect(result).toMatchObject({ available: false, agentRuntime: { available: true }, message: 'AI 助手暂不可用' });
  });

  it('degrades safely when Agent Runtime cannot be reached', async () => {
    const internalError = 'connect ECONNREFUSED agent-runtime.internal:3100 secret-token';
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const service = new AssistantStatusService(prisma as never);

    await expect(
      service.getStatus({
        agentRuntimeUrl: 'http://agent-runtime.test',
        fetchImpl: vi.fn().mockRejectedValue(new Error(internalError)),
        now: () => checkedAt,
      }),
    ).resolves.toEqual({
      available: false,
      core: { available: true },
      agentRuntime: { available: false },
      checkedAt: checkedAt.toISOString(),
      message: 'AI 助手暂不可用',
    });

    const response = JSON.stringify(await service.getStatus({
      agentRuntimeUrl: 'http://agent-runtime.test',
      fetchImpl: vi.fn().mockRejectedValue(new Error(internalError)),
      now: () => checkedAt,
    }));
    expect(response).not.toContain(internalError);
  });

  it('briefly coalesces public status probes to avoid dependency amplification', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', service: 'agent-runtime' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env['AGENT_RUNTIME_URL'] = 'http://agent-runtime.test';
    const service = new AssistantStatusService(prisma as never);

    await Promise.all([service.getStatus(), service.getStatus(), service.getStatus()]);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
