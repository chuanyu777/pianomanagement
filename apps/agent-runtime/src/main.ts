import 'dotenv/config';
import { createCheckpointer } from './checkpoint/checkpointer.js';
import { parseAgentConfig } from './config/agent-config.js';
import { createAgentRuntimeRepository } from './persistence/repository.js';
import { buildServer } from './server.js';

const config = parseAgentConfig(process.env);
const checkpointer = createCheckpointer(config.AGENT_DATABASE_URL);
const repository = createAgentRuntimeRepository({ connectionString: config.AGENT_DATABASE_URL });
const app = buildServer({ config, checkpointer, repository });

let closing: Promise<void> | undefined;
const close = async (): Promise<void> => {
  closing ??= Promise.allSettled([
    app.close(),
    checkpointer.end(),
    repository.close(),
  ]).then((results) => {
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Agent Runtime 关闭失败',
      );
    }
  });
  return closing;
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await app.listen({ port: config.AGENT_PORT, host: '0.0.0.0' });
