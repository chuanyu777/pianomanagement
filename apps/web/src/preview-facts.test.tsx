import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PreviewFacts } from './preview-facts.js';

describe('PreviewFacts', () => {
  it('names the balances and course amounts used in lesson and final refund confirmation', () => {
    render(<PreviewFacts value={{ paidBalanceBefore: '1000.00', giftBalanceBefore: '100.00', paidBalanceAfter: '920.00', giftBalanceAfter: '0.00', courses: [{ courseName: '主课', paidRefundAmount: '920.00', giftClearingAmount: '0.00' }], channel: 'BANK_CARD', executedAt: '2026-10-28T01:00:00.000Z' }} />);
    for (const label of ['操作前实付余额', '操作前赠送余额', '操作后实付余额', '操作后赠送余额', '实付退款金额', '清零赠送金额', '银行卡', '完成时间']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText('¥920.00')).toHaveLength(2);
  });
  it('renders nested balance and compensation facts with Chinese labels and unchanged amounts', () => {
    render(<PreviewFacts value={{
      beforeBalance: { paidBalance: '120.00', giftBalance: '20.00', totalBalance: '140.00' },
      afterBalance: { paidBalance: '80.00', giftBalance: '20.00', totalBalance: '100.00' },
      beforeBaseSalary: '3200.00', afterBaseSalary: '3500.00',
      beforeCommissionRate: '8.0000', afterCommissionRate: '9.2500',
      createsLoginAccount: false,
    }} />);

    expect(screen.getByText('操作前余额')).toBeInTheDocument();
    expect(screen.getByText('操作后余额')).toBeInTheDocument();
    expect(screen.getAllByText('实付余额')).toHaveLength(2);
    expect(screen.getByText('¥120.00')).toBeInTheDocument();
    expect(screen.getByText('¥3500.00')).toBeInTheDocument();
    expect(screen.getByText('9.2500%')).toBeInTheDocument();
    expect(screen.getByText('不会创建登录账号')).toBeInTheDocument();
    expect(screen.queryByText('beforeBalance')).not.toBeInTheDocument();
  });

  it('keeps decision details and nested entries while hiding internal identifiers and idempotency data', () => {
    render(<PreviewFacts value={{
      studentName: '小雨', courseName: '钢琴课', amount: '240.00', channel: 'BANK_TRANSFER',
      occurredAt: '2026-10-28T01:02:03.000Z', note: '补交课时费', reason: '核对后退款',
      courses: [{ courseName: '钢琴课', refundAmount: '200.00', feeAmount: '40.00' }],
      studentId: 'student-secret', previewId: 'preview-secret', requestId: 'request-secret',
      idempotencyKey: 'idempotency-secret', auditEventId: 'audit-secret',
    }} />);

    expect(screen.getByText('学生')).toBeInTheDocument();
    expect(screen.getByText('小雨')).toBeInTheDocument();
    expect(screen.getByText('收付款渠道')).toBeInTheDocument();
    expect(screen.getByText('银行转账')).toBeInTheDocument();
    expect(screen.getByText('业务发生时间')).toBeInTheDocument();
    expect(screen.getByText('原因')).toBeInTheDocument();
    expect(screen.getByText('课程明细')).toBeInTheDocument();
    const details = screen.getByText('课程明细').parentElement;
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText('退款金额')).toBeInTheDocument();
    expect(screen.queryByText(/student-secret|preview-secret|request-secret|idempotency-secret|audit-secret/)).not.toBeInTheDocument();
  });
});
