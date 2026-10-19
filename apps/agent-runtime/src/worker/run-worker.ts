import { randomUUID } from 'node:crypto';
import type {
  AgentRunRecord,
  AgentRuntimeRepository,
  AppendMessageInput,
  LeasedAgentRunRecord,
  PersistedAssistantEvent,
  UpdateRunInput,
} from '../persistence/repository.js';
import type { AssistantEvent } from '@piano/assistant-protocol';

export type RunWorkerRepository = Pick<
  AgentRuntimeRepository,
  | 'claimNextRun'
  | 'renewRunLease'
  | 'requeueExpiredRunLeases'
  | 'updateRunWithEvent'
  | 'appendEvent'
  | 'appendMessage'
>;

export class RunLeaseLostError extends Error {
  constructor() {
    super('运行租约已失效');
    this.name = 'RunLeaseLostError';
  }
}

export type RunExecutionContext = {
  run: AgentRunRecord;
  leaseOwnerToken?: string;
  signal: AbortSignal;
  appendEvent(event: AssistantEvent): Promise<PersistedAssistantEvent>;
  appendMessage(input: Omit<AppendMessageInput, 'runId' | 'leaseOwnerToken'>): Promise<void>;
  updateRunWithEvent(
    input: Omit<UpdateRunInput, 'runId' | 'leaseOwnerToken'>,
    event: AssistantEvent,
  ): Promise<AgentRunRecord>;
};

export type RunWorkerOptions = {
  repository: RunWorkerRepository;
  execute(context: RunExecutionContext): Promise<void>;
  ownerToken?: string;
  leaseDurationMs: number;
  renewIntervalMs: number;
  pollIntervalMs: number;
  recoveryBatchSize: number;
  onError?: (error: unknown) => void;
  onEvent?: (runId: string, event: PersistedAssistantEvent) => void;
};

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof RunLeaseLostError || (error instanceof Error && error.message === '运行不存在或租约已失效');
}

export class RunWorker {
  readonly #options: RunWorkerOptions;
  readonly #ownerToken: string;
  #started = false;
  #running = false;
  #loopPromise: Promise<void> | undefined;
  #activePromise: Promise<void> | undefined;
  #wakePoll: (() => void) | undefined;

  constructor(options: RunWorkerOptions) {
    assertPositiveInteger('租约时长', options.leaseDurationMs);
    assertPositiveInteger('续租间隔', options.renewIntervalMs);
    assertPositiveInteger('轮询间隔', options.pollIntervalMs);
    assertPositiveInteger('回收批量大小', options.recoveryBatchSize);
    this.#options = options;
    this.#ownerToken = options.ownerToken ?? randomUUID();
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.recoverExpiredLeases();
    this.#running = true;
    this.#loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wakePoll?.();
    await this.#loopPromise;
    await this.#activePromise;
    this.#loopPromise = undefined;
    this.#started = false;
  }

  async drain(): Promise<void> {
    await this.#activePromise;
  }

  private async recoverExpiredLeases(): Promise<void> {
    for (;;) {
      const requeued = await this.#options.repository.requeueExpiredRunLeases(this.#options.recoveryBatchSize);
      if (requeued < this.#options.recoveryBatchSize) return;
    }
  }

  private async loop(): Promise<void> {
    while (this.#running) {
      const run = await this.#options.repository.claimNextRun(
        this.#ownerToken,
        this.#options.leaseDurationMs,
      );
      if (!run) {
        await this.waitForPoll();
        continue;
      }
      this.#activePromise = this.executeRun(run);
      try {
        await this.#activePromise;
      } finally {
        this.#activePromise = undefined;
      }
    }
  }

  private async executeRun(run: LeasedAgentRunRecord): Promise<void> {
    const controller = new AbortController();
    let leaseLost = false;
    let renewInFlight = false;
    const renewTimer = setInterval(() => {
      if (leaseLost || renewInFlight) return;
      renewInFlight = true;
      void this.#options.repository
        .renewRunLease(run.runId, run.leaseOwnerToken, this.#options.leaseDurationMs)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            controller.abort(new RunLeaseLostError());
          }
        })
        .catch((error: unknown) => {
          leaseLost = true;
          controller.abort(error);
          this.#options.onError?.(error);
        })
        .finally(() => {
          renewInFlight = false;
        });
    }, this.#options.renewIntervalMs);

    const assertLease = (): void => {
      if (leaseLost || controller.signal.aborted) throw new RunLeaseLostError();
    };
    const context: RunExecutionContext = {
      run,
      leaseOwnerToken: run.leaseOwnerToken,
      signal: controller.signal,
      appendEvent: async (event) => {
        assertLease();
        const persisted = await this.#options.repository.appendEvent(run.runId, event, run.leaseOwnerToken);
        this.#options.onEvent?.(run.runId, persisted);
        return persisted;
      },
      appendMessage: async (input) => {
        assertLease();
        await this.#options.repository.appendMessage({
          ...input,
          runId: run.runId,
          leaseOwnerToken: run.leaseOwnerToken,
        });
      },
      updateRunWithEvent: async (input, event) => {
        assertLease();
        const committed = await this.#options.repository.updateRunWithEvent({
          ...input,
          runId: run.runId,
          leaseOwnerToken: run.leaseOwnerToken,
        }, event);
        this.#options.onEvent?.(run.runId, committed.event);
        return committed.run;
      },
    };

    try {
      await this.#options.execute(context);
      if (!leaseLost) {
        await context.updateRunWithEvent(
          { status: 'completed' },
          { type: 'run.completed', runId: run.runId },
        );
      }
    } catch (error) {
      if (leaseLost || isLeaseLost(error)) return;
      try {
        await context.updateRunWithEvent(
          { status: 'failed', errorCode: 'GRAPH_FAILED' },
          {
            type: 'run.failed',
            code: 'GRAPH_FAILED',
            message: 'Agent 运行失败，请稍后重试',
            retryable: true,
          },
        );
      } catch (persistError) {
        if (!isLeaseLost(persistError)) this.#options.onError?.(persistError);
      }
      this.#options.onError?.(error);
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async waitForPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#wakePoll = undefined;
        resolve();
      }, this.#options.pollIntervalMs);
      this.#wakePoll = () => {
        clearTimeout(timeout);
        this.#wakePoll = undefined;
        resolve();
      };
    });
  }
}
