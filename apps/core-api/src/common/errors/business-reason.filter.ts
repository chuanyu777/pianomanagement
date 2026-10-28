import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

/**
 * Stable, machine-readable rejection reasons. The assistant runtime maps these to
 * plain-language guidance, so the wording of `message` can change freely while the
 * contract stays intact.
 */
export type BusinessReason =
  | 'ROLE_OWNER_ONLY'
  | 'FORBIDDEN'
  | 'PERIOD_CLOSED'
  | 'PAYROLL_ALREADY_PAID'
  | 'VERSION_CONFLICT'
  | 'PREVIEW_STALE'
  | 'NOT_FOUND'
  | 'CONFLICT';

type ErrorBody = {
  statusCode?: number;
  message?: unknown;
  error?: unknown;
  code?: string;
  [key: string]: unknown;
};

function reasonFor(status: number, message: string): BusinessReason | undefined {
  if (status === HttpStatus.FORBIDDEN) {
    return /店主|OWNER/u.test(message) ? 'ROLE_OWNER_ONLY' : 'FORBIDDEN';
  }
  if (status === HttpStatus.CONFLICT) {
    if (/关账/u.test(message)) return 'PERIOD_CLOSED';
    if (/已经支付|已支付/u.test(message)) return 'PAYROLL_ALREADY_PAID';
    if (/已变化|版本/u.test(message)) return 'VERSION_CONFLICT';
    if (/已失效|已被其他请求|过期/u.test(message)) return 'PREVIEW_STALE';
    return 'CONFLICT';
  }
  if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND';
  return undefined;
}

function readMessage(body: ErrorBody): string {
  if (Array.isArray(body.message)) return body.message.map(String).join('；');
  return typeof body.message === 'string' ? body.message : '';
}

@Catch(HttpException)
export class BusinessReasonFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const body: ErrorBody = typeof raw === 'string' ? { statusCode: status, message: raw } : { ...(raw as ErrorBody) };
    const message = readMessage(body);
    const reason = body.code ?? reasonFor(status, message);
    response.status(status).json({
      ...body,
      statusCode: status,
      ...(reason ? { code: reason } : {}),
    });
  }
}
