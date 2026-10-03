import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorBody } from '@piano/shared';
import type { Request, Response } from 'express';

/**
 * 全局异常出口。所有错误响应都必须长成 ApiErrorBody 的样子，前端才能稳定解析。
 *
 * 两条硬规则：
 * 1. 500 类错误对外只给一句通用文案，内部细节只进日志 —— 别把栈和 SQL 泄露给前端。
 * 2. 响应体里带 `code`，前端按 code 分支；不要让它按 message 文本判断。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(this.toBody(exception, status));
  }

  private toBody(exception: unknown, status: number): ApiErrorBody {
    if (!(exception instanceof HttpException)) {
      return { statusCode: status, message: '服务器内部错误', code: 'INTERNAL_ERROR' };
    }

    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      return { statusCode: status, message: payload };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record.message;
    const messages = Array.isArray(rawMessage) ? rawMessage.map(String) : undefined;

    return {
      statusCode: status,
      message: messages ? messages.join('; ') : String(rawMessage ?? exception.message),
      code: typeof record.code === 'string' ? record.code : undefined,
      details: messages ? messages.map((message) => ({ field: '-', message })) : undefined,
    };
  }
}
