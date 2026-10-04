import { useState } from 'react';
import type { ReactNode } from 'react';
import dayjs from 'dayjs';
import { useCustom, useCustomMutation, useList } from '@refinedev/core';
import type { TableColumnsType } from 'antd';
import {
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { currentPeriod } from '../../period';

/**
 * 工资表（US-PR-01…06）。整块仅店主可见（后端 RolesGuard 把守）。
 *
 * 业绩与课消奖由后端按当月已确认课时实时汇总，前端只展示、不做任何计算；
 * 本页只录入出勤、基本工资、各类奖金、课消奖比例与代扣项明细。
 * 两口径（经营支出=本月应发、现金支出=上月应发）相差一个月是既定业务口径。
 *
 * 提交注意：data-provider 的 update 走 PATCH，而工资接口是 PUT /payroll/:teacherId，
 * 所以编辑用 useCustomMutation(method: 'put')。后端只覆盖传了的字段，
 * 因此表单里留空的字段不会进入 payload（= 保持原值）。
 */

type SerializedDeduction = { deductionItemId: string; name: string; amount: string };

type PayrollRow = {
  teacherId: string;
  teacherName: string;
  teacherStatus: string;
  attendance: { expected: number; actual: number; absent: number };
  baseSalary: string;
  pianoBonus: string;
  recruitBonus: string;
  performance: string;
  commissionRate: string;
  commission: string;
  grossSalary: string;
  deductions: SerializedDeduction[];
  totalDeduction: string;
  netSalary: string;
  confirmedLessonCount: number;
};

type PayrollSheet = {
  period: string;
  rows: PayrollRow[];
  totals: {
    grossTotal: string;
    netTotal: string;
    performanceTotal: string;
    totalDeduction: string;
  };
};

type PayrollTotals = {
  period: string;
  accruedTotal: string;
  cashTotal: string;
  previousPeriod: string;
};

type OptionalPayrollColumn = { key: string; label: string; defaultEnabled: boolean };

type DeductionItem = { id: string; name: string };

type EditFormValues = {
  attendanceExpected?: number | null;
  attendanceActual?: number | null;
  attendanceAbsent?: number | null;
  baseSalary?: number | null;
  pianoBonus?: number | null;
  recruitBonus?: number | null;
  commissionRate?: number | null;
  deductions?: { deductionItemId: string; amount: number }[];
};

/** 表格列定义（自带合计值），渲染时再映射成 antd 列，方便合计行按同一顺序对齐。 */
type SheetColumn = {
  key: string;
  title: string;
  dataIndex?: string;
  align?: 'right';
  width?: number;
  render?: (row: PayrollRow) => ReactNode;
  summaryText?: string;
};

/** 展示转换：0~1 小数 → 百分比（提交时仍传小数）。 */
const toPercent = (value: string) => `${(Number(value) * 100).toFixed(2)}%`;

export const PayrollPage = () => {
  const [period, setPeriod] = useState(() => currentPeriod());

  const sheetQuery = useCustom<PayrollSheet>({
    url: `/payroll?period=${period}`,
    method: 'get',
  });
  const totalsQuery = useCustom<PayrollTotals>({
    url: `/payroll/totals?period=${period}`,
    method: 'get',
  });
  const columnsQuery = useCustom<OptionalPayrollColumn[]>({
    url: '/payroll/columns',
    method: 'get',
  });
  const deductionItemsQuery = useList<DeductionItem>({
    resource: 'items/deduction',
    pagination: { pageSize: 200 },
  });

  const sheet = sheetQuery.result?.data;
  const totals = totalsQuery.result?.data;
  const optionalColumns = columnsQuery.result?.data ?? [];
  const deductionOptions = (deductionItemsQuery.result.data ?? []).map((item) => ({
    label: item.name,
    value: item.id,
  }));

  // 可选列开关状态由前端本地保存（后端只给定义，不落库）
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const isColumnEnabled = (col: OptionalPayrollColumn) => enabledMap[col.key] ?? col.defaultEnabled;

  // custom 查询不走 resource 失效，编辑/重算后手动刷
  const refetchAll = () => {
    sheetQuery.query.refetch();
    totalsQuery.query.refetch();
  };

  const { mutateAsync: recomputeAsync } = useCustomMutation();
  const { mutateAsync: updateAsync } = useCustomMutation();
  const [recomputing, setRecomputing] = useState(false);

  // 重算对数据零副作用（幂等），等价于「把实时汇总再跑一遍并刷新」
  const onRecompute = async () => {
    setRecomputing(true);
    try {
      await recomputeAsync({
        url: `/payroll/recompute?period=${period}`,
        method: 'post',
        values: {},
      });
      refetchAll();
    } finally {
      setRecomputing(false);
    }
  };

  // ---------- 编辑基础项 ----------
  const [form] = Form.useForm<EditFormValues>();
  const [editing, setEditing] = useState<PayrollRow | null>(null);
  const [saving, setSaving] = useState(false);

  const openEdit = (row: PayrollRow) => {
    setEditing(row);
    form.setFieldsValue({
      attendanceExpected: row.attendance.expected,
      attendanceActual: row.attendance.actual,
      attendanceAbsent: row.attendance.absent,
      baseSalary: Number(row.baseSalary),
      pianoBonus: Number(row.pianoBonus),
      recruitBonus: Number(row.recruitBonus),
      commissionRate: Number(row.commissionRate),
      deductions: row.deductions.map((d) => ({
        deductionItemId: d.deductionItemId,
        amount: Number(d.amount),
      })),
    });
  };

  const closeEdit = () => {
    setEditing(null);
    form.resetFields();
  };

  const submitEdit = async (values: EditFormValues) => {
    if (!editing) return;
    // 只传填了的字段；留空 = 保持原值（后端不覆盖未传字段）。
    const payload: Record<string, unknown> = { period };
    const putIfPresent = (key: string, value: number | null | undefined) => {
      if (value !== undefined && value !== null) payload[key] = value;
    };
    putIfPresent('attendanceExpected', values.attendanceExpected);
    putIfPresent('attendanceActual', values.attendanceActual);
    putIfPresent('attendanceAbsent', values.attendanceAbsent);
    putIfPresent('baseSalary', values.baseSalary);
    putIfPresent('pianoBonus', values.pianoBonus);
    putIfPresent('recruitBonus', values.recruitBonus);
    putIfPresent('commissionRate', values.commissionRate);
    // 代扣明细传了（含空数组）就整体替换
    payload.deductions = (values.deductions ?? []).map((d) => ({
      deductionItemId: d.deductionItemId,
      amount: d.amount,
    }));

    setSaving(true);
    try {
      await updateAsync({
        url: `/payroll/${editing.teacherId}`,
        method: 'put',
        values: payload,
      });
      closeEdit();
      refetchAll();
    } finally {
      setSaving(false);
    }
  };

  // ---------- 列定义 ----------
  const sheetColumns: SheetColumn[] = [
    { key: 'teacherName', title: '老师', dataIndex: 'teacherName', width: 120 },
    {
      key: 'attendance',
      title: '出勤（应到/实到）',
      width: 140,
      render: (row) => `${row.attendance.expected} / ${row.attendance.actual}`,
    },
    // 可选列（应发基础工资 / 钢琴），默认关闭，可在列开关里打开
    ...optionalColumns
      .filter((col) => isColumnEnabled(col))
      .map((col) => ({
        key: col.key,
        title: col.label,
        dataIndex: col.key,
        align: 'right' as const,
        width: 110,
      })),
    { key: 'recruitBonus', title: '招生奖', dataIndex: 'recruitBonus', align: 'right', width: 110 },
    {
      key: 'performance',
      title: '业绩',
      dataIndex: 'performance',
      align: 'right',
      width: 110,
      summaryText: sheet?.totals.performanceTotal,
    },
    {
      key: 'commissionRate',
      title: '课消奖比例',
      dataIndex: 'commissionRate',
      align: 'right',
      width: 110,
      render: (row) => toPercent(row.commissionRate),
    },
    { key: 'commission', title: '课消奖', dataIndex: 'commission', align: 'right', width: 110 },
    {
      key: 'grossSalary',
      title: '应发',
      dataIndex: 'grossSalary',
      align: 'right',
      width: 110,
      summaryText: sheet?.totals.grossTotal,
    },
    {
      key: 'totalDeduction',
      title: '代扣合计',
      dataIndex: 'totalDeduction',
      align: 'right',
      width: 110,
      summaryText: sheet?.totals.totalDeduction,
    },
    {
      key: 'netSalary',
      title: '实发',
      dataIndex: 'netSalary',
      align: 'right',
      width: 110,
      summaryText: sheet?.totals.netTotal,
    },
    {
      key: 'confirmedLessonCount',
      title: '课时数',
      dataIndex: 'confirmedLessonCount',
      align: 'right',
      width: 90,
    },
    {
      key: 'actions',
      title: '操作',
      width: 80,
      render: (row) => (
        <Button size="small" onClick={() => openEdit(row)}>
          编辑
        </Button>
      ),
    },
  ];

  const tableColumns: TableColumnsType<PayrollRow> = sheetColumns.map((col) => ({
    key: col.key,
    title: col.title,
    dataIndex: col.dataIndex,
    align: col.align,
    width: col.width,
    render: col.render,
  }));

  // ---------- 渲染 ----------
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text>月份：</Typography.Text>
        <DatePicker
          picker="month"
          allowClear={false}
          value={dayjs(period, 'YYYY-MM')}
          onChange={(value) => {
            if (value) setPeriod(value.format('YYYY-MM'));
          }}
        />
        <Button icon={<ReloadOutlined />} loading={recomputing} onClick={onRecompute}>
          按课时重算业绩
        </Button>
      </Space>

      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title={`经营支出（${period} 应发合计）`} value={totals?.accruedTotal ?? '—'} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={`现金支出（${totals?.previousPeriod ?? '上月'} 应发合计）`}
              value={totals?.cashTotal ?? '—'}
            />
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        业绩与课消奖由系统按当月已确认课时实时计算，此处只展示、不可录入；出勤、基本工资、各类奖金与代扣项可在「编辑」里填写。
        现金支出取上月应发（工资下个月才发），与经营支出相差一个月是既定口径，不是错误。
      </Typography.Paragraph>

      <Space wrap>
        <Typography.Text type="secondary">可选列：</Typography.Text>
        {optionalColumns.map((col) => (
          <Checkbox
            key={col.key}
            checked={isColumnEnabled(col)}
            onChange={(e) =>
              setEnabledMap((prev) => ({ ...prev, [col.key]: e.target.checked }))
            }
          >
            {col.label}
          </Checkbox>
        ))}
      </Space>

      <Table<PayrollRow>
        rowKey="teacherId"
        dataSource={sheet?.rows ?? []}
        loading={sheetQuery.query.isLoading}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={tableColumns}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>合计</Typography.Text>
              </Table.Summary.Cell>
              {sheetColumns.slice(1).map((col, i) => (
                <Table.Summary.Cell
                  key={col.key}
                  index={i + 1}
                  align={col.align === 'right' ? 'right' : undefined}
                >
                  {col.summaryText ?? ''}
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      <Modal
        open={editing !== null}
        title={editing ? `编辑基础项：${editing.teacherName}` : ''}
        onCancel={closeEdit}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          只提交本表单里填写的字段，留空的不会被改动。课消奖比例是 0~1 的小数（0.15 表示 15%）。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={submitEdit}>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="attendanceExpected" label="出勤应到（天）">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="attendanceActual" label="出勤实到（天）">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="attendanceAbsent" label="缺勤（天）">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="baseSalary" label="基本工资">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="pianoBonus" label="钢琴奖">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="recruitBonus" label="招生奖">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="commissionRate"
            label="课消奖比例（0~1）"
            extra="0~1 的小数，0.15 表示 15%；留空沿用档案/机构默认"
          >
            <InputNumber min={0} max={1} step={0.01} precision={4} style={{ width: '100%' }} />
          </Form.Item>

          <Typography.Text strong>代扣项明细</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            保存后按下面的列表整体替换；删光即清空代扣项。
          </Typography.Paragraph>
          <Form.List name="deductions">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex' }}>
                    <Form.Item
                      name={[field.name, 'deductionItemId']}
                      rules={[{ required: true, message: '请选择代扣项' }]}
                    >
                      <Select options={deductionOptions} placeholder="代扣项" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'amount']}
                      rules={[{ required: true, message: '请输入金额' }]}
                    >
                      <InputNumber min={0} precision={2} placeholder="金额" style={{ width: 140 }} />
                    </Form.Item>
                    <Button type="text" danger onClick={() => remove(field.name)}>
                      删除
                    </Button>
                  </Space>
                ))}
                <Form.Item>
                  <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>
                    添加代扣项
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>

          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>
    </Space>
  );
};
