import { ConflictException, ForbiddenException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BusinessReasonFilter } from './business-reason.filter.js';

function filter(exception: HttpException): Record<string, unknown> {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  new BusinessReasonFilter().catch(exception, host);
  expect(status).toHaveBeenCalledWith(exception.getStatus());
  return json.mock.calls[0]![0] as Record<string, unknown>;
}

describe('BusinessReasonFilter', () => {
  it.each(['该业务月份已关账，不能修改资金或课消记录', '该月份已经关账'])(
    'classifies an actually closed period and provides constrained guidance: %s',
    (message) => {
      const body = filter(new ConflictException(message));
      expect(body).toMatchObject({ code: 'PERIOD_CLOSED', message });
      expect(body.guidance).toContain('当前开放月份');
      expect(body.guidance).toContain('最近一次关账');
      expect(body.guidance).toContain('原因');
    },
  );

  it.each([
    '该月份存在关账阻断：存在未确认课程',
    '该月份存在关账阻断：该业务月份已关账',
    '重开关账月份必须填写原因',
    '只能重新打开最近一次关账的月份',
    '关账预览服务未配置',
    '该月份尚未关账',
  ])('does not classify other closing conflicts as a closed period: %s', (message) => {
    expect(filter(new ConflictException(message))).toMatchObject({ code: 'CONFLICT', message });
    expect(filter(new ConflictException(message))).not.toHaveProperty('guidance');
  });

  it.each([
    ['工资已支付', 'PAYROLL_ALREADY_PAID'],
    ['数据版本已变化', 'VERSION_CONFLICT'],
    ['预览已失效', 'PREVIEW_STALE'],
    ['其他冲突', 'CONFLICT'],
  ])('preserves other conflict classifications: %s', (message, code) => {
    expect(filter(new ConflictException(message))).toMatchObject({ code, message });
  });

  it('preserves explicit codes and forbidden classification', () => {
    expect(filter(new ConflictException({ message: '该月份已经关账', code: 'CUSTOM' }))).toMatchObject({ code: 'CUSTOM' });
    expect(filter(new ForbiddenException('仅店主可操作'))).toMatchObject({ code: 'ROLE_OWNER_ONLY' });
  });
});
