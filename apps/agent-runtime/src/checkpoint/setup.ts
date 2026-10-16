import 'dotenv/config';
import { parseAgentConfig } from '../config/agent-config.js';
import { createCheckpointer } from './checkpointer.js';

const config = parseAgentConfig(process.env);
const checkpointer = createCheckpointer(config.AGENT_DATABASE_URL);

try {
  await checkpointer.setup();
} finally {
  await checkpointer.end();
}
