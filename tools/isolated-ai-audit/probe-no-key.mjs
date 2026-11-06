// Exercises startup, smoke invocation, failure redaction, and cleanup without a real credential.
process.env.AI_MODEL='deepseek-chat';
process.env.AI_API_KEY='isolation-test-invalid-key';
process.argv=[process.argv[0],'tools/isolated-ai-audit/run.mjs','probe'];
await import('./run.mjs');
