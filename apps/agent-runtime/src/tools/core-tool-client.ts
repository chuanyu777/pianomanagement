import { z } from 'zod';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';

const SystemStatusSchema = z.object({
  status: z.literal('available'),
  businessTimezone: z.literal('Asia/Shanghai'),
  serverTime: z.iso.datetime(),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export class CoreToolClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly serviceSecret: string,
  ) {}

  async getSystemStatus(capabilityToken: string): Promise<SystemStatus> {
    const url = `${this.baseUrl}/tools/system-status`;
    const target = new URL(url);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${capabilityToken}`,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return SystemStatusSchema.parse(await response.json());
  }
}
