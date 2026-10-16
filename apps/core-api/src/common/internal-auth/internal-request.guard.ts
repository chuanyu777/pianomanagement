import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import {
  InternalRequestReplayProtector,
  verifySignedInternalRequest,
} from '@piano/assistant-protocol/internal-auth';

type InternalRequest = {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl: string;
};

function headerValue(request: InternalRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class InternalRequestGuard implements CanActivate {
  readonly #replayProtector = new InternalRequestReplayProtector();

  canActivate(context: ExecutionContext): boolean {
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
      }) ||
      !this.#replayProtector.consume(nonce)
    ) {
      throw new UnauthorizedException('服务鉴权失败');
    }

    return true;
  }
}
