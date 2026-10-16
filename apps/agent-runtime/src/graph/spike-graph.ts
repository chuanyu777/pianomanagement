import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import { z } from 'zod';
import type { SystemStatus } from '../tools/core-tool-client.js';

const ApprovalSchema = z.object({ approved: z.boolean() });

const SpikeState = Annotation.Root({
  runId: Annotation<string>(),
  threadId: Annotation<string>(),
  userMessage: Annotation<string>(),
  systemStatus: Annotation<SystemStatus | undefined>(),
  approved: Annotation<boolean | undefined>(),
  answer: Annotation<string | undefined>(),
});

export type SpikeStateValue = typeof SpikeState.State;

export function createSpikeGraph(input: {
  checkpointer: BaseCheckpointSaver;
  fetchSystemStatus: () => Promise<SystemStatus>;
}) {
  return new StateGraph(SpikeState)
    .addNode('readCoreStatus', async () => ({ systemStatus: await input.fetchSystemStatus() }))
    .addNode('requestApproval', (state) => {
      const decision = interrupt(
        {
          kind: 'technical-preview',
          title: '阶段 0：验证暂停与恢复',
          description: '此操作只恢复技术验证 Graph，不写入任何业务数据。',
          coreStatus: state.systemStatus,
        },
        { responseSchema: ApprovalSchema },
      );
      return { approved: decision.approved };
    })
    .addNode('finish', (state) => ({
      answer: state.approved ? '技术验证已确认完成。' : '技术验证已取消。',
    }))
    .addEdge(START, 'readCoreStatus')
    .addEdge('readCoreStatus', 'requestApproval')
    .addEdge('requestApproval', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer: input.checkpointer });
}

export function resumeApproval(
  approved: boolean,
): Command<{ approved: boolean }, Partial<SpikeStateValue>, never> {
  return new Command({ resume: { approved } });
}
