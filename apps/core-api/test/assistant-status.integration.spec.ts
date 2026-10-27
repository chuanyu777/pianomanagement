import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AssistantStatusService } from '../src/modules/assistant-status/assistant-status.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AssistantStatusService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new AssistantStatusService(prisma);

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('reports a healthy Core database and healthy Agent Runtime contract', async () => {
      const status = await service.getStatus({
        agentRuntimeUrl: 'http://agent-runtime.test',
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ status: 'ok', service: 'agent-runtime', modelAvailable: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      });

      expect(status.available).toBe(true);
      expect(status.core).toEqual({ available: true });
      expect(status.agentRuntime).toEqual({ available: true });
    });
  });
} else {
  describe.skip('AssistantStatusService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
