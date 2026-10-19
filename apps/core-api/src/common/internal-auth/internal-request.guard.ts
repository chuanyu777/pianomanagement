import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import {
  verifySignedInternalRequest,
} from '@piano/assistant-protocol/internal-auth';
import {
  InMemoryInternalRequestReplayStore,
  PostgresInternalRequestReplayStore,
  type InternalRequestReplayStore,
} from './replay-protector.js';

type InternalRequest = {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl: string;
};

function headerValue(request: InternalRequest, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(request.headers).find(([key]) => key.toLowerCase() === normalizedName);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

@Injectable()
export class InternalRequestGuard implements CanActivate {
  constructor(
    @Inject(PostgresInternalRequestReplayStore)
    private readonly replayStore: InternalRequestReplayStore = new InMemoryInternalRequestReplayStore(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<InternalRequest>();
    const timestamp = headerValue(request, INTERNAL_REQUEST_TIMESTAMP_HEADER);
    const nonce = headerValue(request, INTERNAL_REQUEST_NONCE_HEADER);
    const signature = headerValue(request, INTERNAL_REQUEST_SIGNATURE_HEADER);
    const secret = process.env['INTERNAL_SERVICE_SECRET'];

    if (
      !secret ||
      !timestamp ||
      !nonce ||
      !signature ||
      !verifySignedInternalRequest({
        secret,
        timestamp,
        nonce,
        signature,
        method: request.method,
        path: request.originalUrl,
        body: request.body,
        securityHeaders: {
          authorization: headerValue(request, 'authorization'),
          'x-assistant-capability': headerValue(request, 'x-assistant-capability'),
          'last-event-id': headerValue(request, 'last-event-id'),
        },
      }) ||
      !(await this.replayStore.consume(nonce))
    ) {
      throw new UnauthorizedException('服务鉴权失败');
    }

    return true;
  }
}
