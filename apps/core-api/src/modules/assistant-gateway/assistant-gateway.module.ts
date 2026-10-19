import { Module } from '@nestjs/common';
import { CapabilityModule } from '../../common/capability/capability.module.js';
import {
  AGENT_RUNTIME_CLIENT,
  HttpAgentRuntimeClient,
} from './agent-runtime.client.js';
import { AssistantGatewayService } from './assistant-gateway.service.js';
import { AssistantGatewayController } from './assistant-gateway.controller.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 配置无效`);
  return parsed;
}

@Module({
  imports: [CapabilityModule],
  providers: [
    {
      provide: AGENT_RUNTIME_CLIENT,
      useFactory: () =>
        new HttpAgentRuntimeClient({
          baseUrl: requiredEnv('AGENT_RUNTIME_URL'),
          serviceSecret: requiredEnv('INTERNAL_SERVICE_SECRET'),
          timeoutMs: positiveIntegerEnv('AGENT_REQUEST_TIMEOUT_MS', 15_000),
          streamIdleTimeoutMs: positiveIntegerEnv('AGENT_STREAM_IDLE_TIMEOUT_MS', 30_000),
        }),
    },
    AssistantGatewayService,
  ],
  controllers: [AssistantGatewayController],
  exports: [AGENT_RUNTIME_CLIENT, AssistantGatewayService],
})
export class AssistantGatewayModule {}
