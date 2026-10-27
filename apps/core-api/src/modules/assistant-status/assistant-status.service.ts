import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

const DEFAULT_AGENT_STATUS_TIMEOUT_MS = 2_000;
const STATUS_CACHE_TTL_MS = 2_000;

export type AssistantComponentStatus = {
  available: boolean;
};

export type AssistantStatus = {
  available: boolean;
  core: AssistantComponentStatus;
  agentRuntime: AssistantComponentStatus;
  checkedAt: string;
  message: 'AI 助手已连接' | 'AI 助手暂不可用';
};

export type AssistantStatusProbeOptions = {
  agentRuntimeUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

type AgentHealth = {
  status?: unknown;
  service?: unknown;
  modelAvailable?: unknown;
};

@Injectable()
export class AssistantStatusService {
  #cached?: { expiresAt: number; value: Promise<AssistantStatus> };

  constructor(private readonly prisma: PrismaService) {}

  async getStatus(options: AssistantStatusProbeOptions = {}): Promise<AssistantStatus> {
    if (Object.keys(options).length > 0) return this.probe(options);
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.value;
    const value = this.probe(options);
    this.#cached = { expiresAt: now + STATUS_CACHE_TTL_MS, value };
    return value;
  }

  private async probe(options: AssistantStatusProbeOptions): Promise<AssistantStatus> {
    const now = options.now ?? (() => new Date());
    const [coreAvailable, agentHealth] = await Promise.all([
      this.checkCore(),
      this.checkAgentRuntime(options),
    ]);
    const available = coreAvailable && agentHealth.available && agentHealth.modelAvailable;

    return {
      available,
      core: { available: coreAvailable },
      agentRuntime: { available: agentHealth.available },
      checkedAt: now().toISOString(),
      message: available ? 'AI 助手已连接' : 'AI 助手暂不可用',
    };
  }

  private async checkCore(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkAgentRuntime(options: AssistantStatusProbeOptions): Promise<{ available: boolean; modelAvailable: boolean }> {
    const agentRuntimeUrl = options.agentRuntimeUrl ?? process.env['AGENT_RUNTIME_URL'];
    if (!agentRuntimeUrl) return { available: false, modelAvailable: false };

    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.readTimeoutFromEnvironment(),
    );

    try {
      const response = await fetchImpl(`${agentRuntimeUrl.replace(/\/$/, '')}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { available: false, modelAvailable: false };

      const payload = (await response.json()) as AgentHealth;
      const available = payload.status === 'ok' && payload.service === 'agent-runtime';
      return { available, modelAvailable: available && payload.modelAvailable === true };
    } catch {
      return { available: false, modelAvailable: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private readTimeoutFromEnvironment(): number {
    const configured = Number(process.env['AGENT_STATUS_TIMEOUT_MS']);
    if (Number.isInteger(configured) && configured > 0) return configured;
    return DEFAULT_AGENT_STATUS_TIMEOUT_MS;
  }
}
