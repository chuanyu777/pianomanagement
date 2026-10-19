import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
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
  model?: BaseChatModel;
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
    .addNode('finish', async (state) => {
      if (!state.approved) return { answer: '技术验证已取消。' };
      if (!input.model) return { answer: '技术验证已确认完成。' };

      try {
        const response = await input.model.invoke([
          new SystemMessage(
            '你是琴行管理系统的 AI 助手。当前仅进行技术验证，不执行或声称执行任何业务操作。请简洁回应用户。',
          ),
          new HumanMessage(state.userMessage),
        ]);
        const answer =
          typeof response.content === 'string'
            ? response.content
            : response.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('');
        return { answer };
      } catch {
        throw new Error('AI_MODEL_REQUEST_FAILED');
      }
    })
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
