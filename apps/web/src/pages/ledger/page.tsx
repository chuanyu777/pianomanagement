import { useMemo, useState } from 'react';
import { useCustom, useList } from '@refinedev/core';
import { List, useTable } from '@refinedev/antd';
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { currentPeriod } from '../../period';

/**
 * 学生余额与课时台账（US-ML-01）。
 *
 * - 余额卡片走 GET /ledger/students/:studentId（period 只是透传，余额是当前值不按月切）
 * - 流水表走 GET /ledger/entries?studentId=&period=&page=&pageSize=，月份只作用于流水
 * - 金额一律显示后端返回的字符串（两位小数），前端不做任何算术（AGENTS.md R4）
 */
type OptionItem = { id: string; name: string };

type EnrollmentLedgerRow = {
  enrollmentId: string;
  courseTypeName: string;
  teacherName: string;
  unitPrice: string;
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
  remainingLessons?: number;
  remainingLessonsHint?: string;
};

type StudentLedger = {
  student: { id: string; name: string; status: string };
  enrollments: EnrollmentLedgerRow[];
  totals: { paidBalance: string; giftBalance: string; totalBalance: string };
  balanceStatus: string;
};

type LedgerEntry = {
  id: string;
  occurredAt: string;
  kind: 'PAYMENT' | 'GIFT' | 'GIFT_REVOKE' | 'CONSUMPTION' | 'CONSUMPTION_REVERSAL' | 'REFUND';
  courseTypeName: string;
  studentName: string;
  teacherName: string;
  paidDelta: string;
  giftDelta: string;
  note: string | null;
};

const KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  PAYMENT: '交费',
  GIFT: '赠送',
  GIFT_REVOKE: '赠送撤销',
  CONSUMPTION: '课消',
  CONSUMPTION_REVERSAL: '课消回冲',
  REFUND: '退费',
};

export const LedgerPage = () => {
  const [studentId, setStudentId] = useState<string>();
  const [period, setPeriod] = useState(currentPeriod());

  const students = useList<OptionItem>({
    resource: 'students',
    pagination: { pageSize: 200 },
  });

  const { result: ledgerResult, query: ledgerQuery } = useCustom<StudentLedger>({
    url: `/ledger/students/${studentId ?? ''}?period=${period}`,
    method: 'get',
    queryOptions: { enabled: Boolean(studentId) },
  });

  const { tableProps } = useTable<LedgerEntry>({
    resource: 'ledger/entries',
    meta: { query: { studentId, period } },
    queryOptions: { enabled: Boolean(studentId) },
  });

  const studentOptions = useMemo(
    () =>
      (students.result?.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [students.result?.data],
  );

  const ledger = ledgerResult?.data;

  return (
    <List title="学生台账">
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col>
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="选择学生"
            style={{ width: 240 }}
            value={studentId}
            onChange={(value) => setStudentId(value)}
            options={studentOptions}
          />
        </Col>
        <Col>
          <DatePicker
            picker="month"
            allowClear={false}
            value={dayjs(period)}
            onChange={(value) => setPeriod(value ? value.format('YYYY-MM') : currentPeriod())}
          />
        </Col>
      </Row>

      <Typography.Paragraph type="secondary">
        余额与剩余课时是当前值（不随月份变化）；下方月份选择只用于筛选流水。
      </Typography.Paragraph>

      {!studentId ? (
        <Empty description="请先选择学生" />
      ) : ledgerQuery.isLoading ? (
        <Spin />
      ) : ledgerQuery.isError ? (
        <Alert type="error" showIcon message={String(ledgerQuery.error)} />
      ) : !ledger ? (
        <Empty description="暂无数据" />
      ) : (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Card size="small">
                <Typography.Text type="secondary">实收余额合计</Typography.Text>
                <Typography.Title level={4} style={{ margin: '4px 0 0' }}>
                  {ledger.totals.paidBalance}
                </Typography.Title>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Typography.Text type="secondary">赠送余额合计</Typography.Text>
                <Typography.Title level={4} style={{ margin: '4px 0 0' }}>
                  {ledger.totals.giftBalance}
                </Typography.Title>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Typography.Text type="secondary">合计</Typography.Text>
                <Typography.Title level={4} style={{ margin: '4px 0 0' }}>
                  {ledger.totals.totalBalance}
                </Typography.Title>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Typography.Text type="secondary">余额状态</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Tag color={ledger.balanceStatus === '欠费' ? 'red' : 'green'}>
                    {ledger.balanceStatus}
                  </Tag>
                </div>
              </Card>
            </Col>
          </Row>

          <Card size="small" title="各课程余额" style={{ marginBottom: 24 }}>
            <Table<EnrollmentLedgerRow>
              rowKey="enrollmentId"
              dataSource={ledger.enrollments}
              pagination={false}
              size="small"
            >
              <Table.Column dataIndex="courseTypeName" title="课程" />
              <Table.Column dataIndex="teacherName" title="老师" />
              <Table.Column dataIndex="unitPrice" title="单价" align="right" />
              <Table.Column dataIndex="paidBalance" title="实收余额" align="right" />
              <Table.Column dataIndex="giftBalance" title="赠送余额" align="right" />
              <Table.Column dataIndex="totalBalance" title="合计" align="right" />
              <Table.Column<EnrollmentLedgerRow>
                title="预计剩余课时"
                align="right"
                render={(_, row) =>
                  row.remainingLessonsHint ??
                  (row.remainingLessons !== undefined ? String(row.remainingLessons) : '-')
                }
              />
            </Table>
          </Card>

          <Card size="small" title={`流水（${period}）`}>
            <Table {...tableProps} rowKey="id" size="small">
              <Table.Column
                dataIndex="occurredAt"
                title="时间"
                width={160}
                render={(value: string) =>
                  new Date(value).toLocaleString('zh-CN', { hour12: false })
                }
              />
              <Table.Column
                dataIndex="kind"
                title="类型"
                width={110}
                render={(value: LedgerEntry['kind']) => KIND_LABEL[value] ?? value}
              />
              <Table.Column dataIndex="courseTypeName" title="课程" />
              <Table.Column dataIndex="paidDelta" title="实收变动" align="right" />
              <Table.Column dataIndex="giftDelta" title="赠送变动" align="right" />
              <Table.Column
                dataIndex="note"
                title="备注"
                render={(value: string | null) => value ?? '-'}
              />
            </Table>
          </Card>
        </>
      )}
    </List>
  );
};
