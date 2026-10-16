import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export function createCheckpointer(
  connectionString: string,
  schema = 'langgraph_checkpoint',
): PostgresSaver {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error('LangGraph checkpoint schema 名称不合法');
  }
  return PostgresSaver.fromConnString(connectionString, { schema });
}
