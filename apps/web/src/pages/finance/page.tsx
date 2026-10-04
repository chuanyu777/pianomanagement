import { useState } from 'react';
import dayjs from 'dayjs';
import { DeleteButton, useTable } from '@refinedev/antd';
import { useCreate, useCustom, useList, useUpdate } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { currentPeriod } from '../../period';

/**
 * 收支（US-IE-01/02/03/04）。整块仅店主可见（后端 RolesGuard 把守）。
 *
 * 报表数据一律来自 useCustom（后端算好的字符串），前端不做任何金额算术；
 * 「本年累计」用列分组展示 ytd 的两个口径，避免前端相加。
 */
type StatementAmounts = { cash: string; consumption: string; operating: string };

type StatementRow = {
  itemId: string;
  name: string;
  isAuto: boolean;
  month: StatementAmounts;
  prevYtd: StatementAmounts;
  ytd: StatementAmounts;
};

type FinanceSummary = {
  incomeCash: string;
  incomeConsumption: string;
  expenseCash: string;
  expenseOperating: string;
  cashBalance: string;
  profit: string;
};

type IncomeItem = { id: string; name: string; autoSource: string | null };
type ExpenseItem = { id: string; name: string; autoSource: string | null };

type OtherExpenseRecord = {
  id: string;
  expenseItemId: string;
  period: string;
  summary: string;
  cashAmount: string;
  occurredAt: string;
};

type ManualIncomeRecord = {
  id: string;
  incomeItemId: string;
  period: string;
  amount: string;
  note: string | null;
};

type OtherExpenseFormValues = {
  expenseItemId: string;
  period: dayjs.Dayjs;
  summary: string;
  cashAmount: number;
  occurredAt?: dayjs.Dayjs;
};

type ManualIncomeFormValues = {
  incomeItemId: string;
  period: dayjs.Dayjs;
  amount: number;
  note?: string;
};

const AutoTag = () => <Tag color="blue">自动</Tag>;

export const FinancePage = () => {
  const [period, setPeriod] = useState(() => currentPeriod());

  const incomeQuery = useCustom<StatementRow[]>({
    url: `/finance/income-statement?period=${period}`,
    method: 'get',
  });
  const expenseQuery = useCustom<StatementRow[]>({
    url: `/finance/expense-statement?period=${period}`,
    method: 'get',
  });
  const summaryQuery = useCustom<FinanceSummary>({
    url: `/finance/summary?period=${period}`,
    method: 'get',
  });

  // 新增/删除手工数据后，报表和小计不会自动失效（custom 查询不走 resource 失效），手动刷一遍
  const refetchStatements = () => {
    incomeQuery.query.refetch();
    expenseQuery.query.refetch();
    summaryQuery.query.refetch();
  };

  const incomeItemsQuery = useList<IncomeItem>({
    resource: 'items/income',
    pagination: { pageSize: 200 },
  });
  const expenseItemsQuery = useList<ExpenseItem>({
    resource: 'items/expense',
    pagination: { pageSize: 200 },
  });

  // 手工补录/其它支出只允许挂在手工项上（autoSource 为空），自动项由系统汇总
  // Array.isArray 保险：Refine 5 首次渲染时 result.data 可能是冻结的空对象（truthy），直接当数组用会崩
  const manualIncomeOptions = (
    Array.isArray(incomeItemsQuery.result?.data) ? incomeItemsQuery.result.data : []
  )
    .filter((item) => item.autoSource === null)
    .map((item) => ({ label: item.name, value: item.id }));
  const manualExpenseOptions = (
    Array.isArray(expenseItemsQuery.result?.data) ? expenseItemsQuery.result.data : []
  )
    .filter((item) => item.autoSource === null)
    .map((item) => ({ label: item.name, value: item.id }));

  const incomeItemName = (id: string) =>
    (Array.isArray(incomeItemsQuery.result?.data) ? incomeItemsQuery.result.data : []).find(
      (item) => item.id === id,
    )?.name ?? id;
  const expenseItemName = (id: string) =>
    (Array.isArray(expenseItemsQuery.result?.data) ? expenseItemsQuery.result.data : []).find(
      (item) => item.id === id,
    )?.name ?? id;

  const summary = summaryQuery.result?.data;

  // ---------- 其它支出 ----------
  const [otherExpenseForm] = Form.useForm<OtherExpenseFormValues>();
  const [editingOtherExpense, setEditingOtherExpense] = useState<OtherExpenseRecord | null>(null);
  const [creatingOtherExpense, setCreatingOtherExpense] = useState(false);
  const otherExpenseModalOpen = creatingOtherExpense || editingOtherExpense !== null;

  const otherExpensesTable = useTable<OtherExpenseRecord>({
    resource: 'finance/other-expenses',
    meta: { query: { period } },
    pagination: { pageSize: 10 },
  });

  const { mutateAsync: createOtherExpenseAsync } = useCreate();
  const { mutateAsync: updateOtherExpenseAsync } = useUpdate();
  const [savingOtherExpense, setSavingOtherExpense] = useState(false);

  const openOtherExpenseCreate = () => {
    setEditingOtherExpense(null);
    setCreatingOtherExpense(true);
    otherExpenseForm.setFieldsValue({ period: dayjs(period, 'YYYY-MM') });
  };

  const openOtherExpenseEdit = (record: OtherExpenseRecord) => {
    setCreatingOtherExpense(false);
    setEditingOtherExpense(record);
    otherExpenseForm.setFieldsValue({
      expenseItemId: record.expenseItemId,
      period: dayjs(record.period, 'YYYY-MM'),
      summary: record.summary,
      cashAmount: Number(record.cashAmount),
      occurredAt: dayjs(record.occurredAt),
    });
  };

  const closeOtherExpense = () => {
    setCreatingOtherExpense(false);
    setEditingOtherExpense(null);
    otherExpenseForm.resetFields();
  };

  const submitOtherExpense = async (values: OtherExpenseFormValues) => {
    const payload = {
      expenseItemId: values.expenseItemId,
      period: values.period.format('YYYY-MM'),
      summary: values.summary,
      cashAmount: values.cashAmount,
      ...(values.occurredAt ? { occurredAt: values.occurredAt.toISOString() } : {}),
    };
    setSavingOtherExpense(true);
    try {
      if (editingOtherExpense) {
        await updateOtherExpenseAsync({
          resource: 'finance/other-expenses',
          id: editingOtherExpense.id,
          values: payload,
        });
      } else {
        await createOtherExpenseAsync({ resource: 'finance/other-expenses', values: payload });
      }
      closeOtherExpense();
      refetchStatements();
    } finally {
      setSavingOtherExpense(false);
    }
  };

  // ---------- 手工补录收入 ----------
  const [manualIncomeForm] = Form.useForm<ManualIncomeFormValues>();
  const [editingManualIncome, setEditingManualIncome] = useState<ManualIncomeRecord | null>(null);
  const [creatingManualIncome, setCreatingManualIncome] = useState(false);
  const manualIncomeModalOpen = creatingManualIncome || editingManualIncome !== null;

  const manualIncomesTable = useTable<ManualIncomeRecord>({
    resource: 'finance/manual-incomes',
    meta: { query: { period } },
    pagination: { pageSize: 10 },
  });

  const { mutateAsync: createManualIncomeAsync } = useCreate();
  const { mutateAsync: updateManualIncomeAsync } = useUpdate();
  const [savingManualIncome, setSavingManualIncome] = useState(false);

  // ---------- 加载 / 错误（必须在所有 hook 之后、读 result?.data 的渲染之前提前返回） ----------
  const loading =
    incomeQuery.query.isLoading || expenseQuery.query.isLoading || summaryQuery.query.isLoading;
  if (loading) return <Spin />;
  const error = incomeQuery.query.error || expenseQuery.query.error || summaryQuery.query.error;
  if (error) return <Alert type="error" message={String(error)} showIcon />;

  const openManualIncomeCreate = () => {
    setEditingManualIncome(null);
    setCreatingManualIncome(true);
    manualIncomeForm.setFieldsValue({ period: dayjs(period, 'YYYY-MM') });
  };

  const openManualIncomeEdit = (record: ManualIncomeRecord) => {
    setCreatingManualIncome(false);
    setEditingManualIncome(record);
    manualIncomeForm.setFieldsValue({
      incomeItemId: record.incomeItemId,
      period: dayjs(record.period, 'YYYY-MM'),
      amount: Number(record.amount),
      note: record.note ?? '',
    });
  };

  const closeManualIncome = () => {
    setCreatingManualIncome(false);
    setEditingManualIncome(null);
    manualIncomeForm.resetFields();
  };

  const submitManualIncome = async (values: ManualIncomeFormValues) => {
    const payload = {
      incomeItemId: values.incomeItemId,
      period: values.period.format('YYYY-MM'),
      amount: values.amount,
      ...(values.note ? { note: values.note } : {}),
    };
    setSavingManualIncome(true);
    try {
      if (editingManualIncome) {
        await updateManualIncomeAsync({
          resource: 'finance/manual-incomes',
          id: editingManualIncome.id,
          values: payload,
        });
      } else {
        await createManualIncomeAsync({ resource: 'finance/manual-incomes', values: payload });
      }
      closeManualIncome();
      refetchStatements();
    } finally {
      setSavingManualIncome(false);
    }
  };

  // ---------- 渲染 ----------
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space>
        <Typography.Text>月份：</Typography.Text>
        <DatePicker
          picker="month"
          allowClear={false}
          value={dayjs(period, 'YYYY-MM')}
          onChange={(value) => {
            if (value) setPeriod(value.format('YYYY-MM'));
          }}
        />
      </Space>

      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="收入小计（现金）" value={summary?.incomeCash ?? '—'} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="支出小计（现金）" value={summary?.expenseCash ?? '—'} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="现金结余" value={summary?.cashBalance ?? '—'} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="盈利" value={summary?.profit ?? '—'} />
          </Card>
        </Col>
      </Row>

      <Tabs
        items={[
          {
            key: 'income',
            label: '收入表',
            children: (
              <Table
                rowKey="itemId"
                dataSource={Array.isArray(incomeQuery.result?.data) ? incomeQuery.result.data : []}
                loading={incomeQuery.query.isLoading}
                pagination={false}
              >
                <Table.Column
                  dataIndex="name"
                  title="项目"
                  render={(_, record: StatementRow) => (
                    <Space>
                      {record.name}
                      {record.isAuto ? <AutoTag /> : <Tag>手工</Tag>}
                    </Space>
                  )}
                />
                <Table.Column dataIndex={['month', 'cash']} title="现金" align="right" />
                <Table.Column dataIndex={['month', 'consumption']} title="课时消费" align="right" />
                <Table.ColumnGroup title="本年累计">
                  <Table.Column dataIndex={['ytd', 'cash']} title="现金" align="right" />
                  <Table.Column dataIndex={['ytd', 'consumption']} title="课时消费" align="right" />
                </Table.ColumnGroup>
              </Table>
            ),
          },
          {
            key: 'expense',
            label: '支出表',
            children: (
              <Table
                rowKey="itemId"
                dataSource={Array.isArray(expenseQuery.result?.data) ? expenseQuery.result.data : []}
                loading={expenseQuery.query.isLoading}
                pagination={false}
              >
                <Table.Column
                  dataIndex="name"
                  title="项目"
                  render={(_, record: StatementRow) => (
                    <Space>
                      {record.name}
                      {record.isAuto ? <AutoTag /> : <Tag>手工</Tag>}
                    </Space>
                  )}
                />
                <Table.Column dataIndex={['month', 'cash']} title="现金" align="right" />
                <Table.Column dataIndex={['month', 'operating']} title="经营" align="right" />
                <Table.ColumnGroup title="本年累计">
                  <Table.Column dataIndex={['ytd', 'cash']} title="现金" align="right" />
                  <Table.Column dataIndex={['ytd', 'operating']} title="经营" align="right" />
                </Table.ColumnGroup>
              </Table>
            ),
          },
          {
            key: 'other-expenses',
            label: '其它支出',
            children: (
              <>
                <Space style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openOtherExpenseCreate}>
                    记一笔其它支出
                  </Button>
                </Space>
                <Table {...otherExpensesTable.tableProps} rowKey="id">
                  <Table.Column
                    dataIndex="expenseItemId"
                    title="支出项目"
                    render={(value: string) => expenseItemName(value)}
                  />
                  <Table.Column dataIndex="period" title="归属月份" width={110} />
                  <Table.Column dataIndex="summary" title="摘要" />
                  <Table.Column dataIndex="cashAmount" title="金额（现金）" align="right" width={130} />
                  <Table.Column
                    dataIndex="occurredAt"
                    title="发生时间"
                    width={170}
                    render={(value: string) => dayjs(value).format('YYYY-MM-DD HH:mm')}
                  />
                  <Table.Column<OtherExpenseRecord>
                    title="操作"
                    width={140}
                    render={(_, record) => (
                      <Space>
                        <Button size="small" onClick={() => openOtherExpenseEdit(record)}>
                          编辑
                        </Button>
                        <DeleteButton
                          hideText
                          size="small"
                          resource="finance/other-expenses"
                          recordItemId={record.id}
                          onSuccess={refetchStatements}
                        />
                      </Space>
                    )}
                  />
                </Table>

                <Modal
                  open={otherExpenseModalOpen}
                  title={editingOtherExpense ? '编辑其它支出' : '记一笔其它支出'}
                  onCancel={closeOtherExpense}
                  footer={null}
                  destroyOnClose
                >
                  <Typography.Paragraph type="secondary">
                    金额必须大于 0；发生时间不填默认为现在。已关账的月份不能记账。
                  </Typography.Paragraph>
                  <Form
                    form={otherExpenseForm}
                    layout="vertical"
                    onFinish={submitOtherExpense}
                  >
                    <Form.Item name="expenseItemId" label="支出项目（仅手工类）" rules={[{ required: true, message: '请选择支出项目' }]}>
                      <Select placeholder="自动取数项由系统汇总，不在此列" options={manualExpenseOptions} />
                    </Form.Item>
                    <Form.Item name="period" label="归属月份" rules={[{ required: true, message: '请选择归属月份' }]}>
                      <DatePicker picker="month" allowClear={false} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="summary" label="摘要" rules={[{ required: true, message: '请输入摘要' }, { max: 200 }]}>
                      <Input placeholder="例如：10 月房租 / 水电费" />
                    </Form.Item>
                    <Form.Item name="cashAmount" label="金额（现金）" rules={[{ required: true, message: '请输入金额' }]}>
                      <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="occurredAt" label="发生时间（不填默认现在）">
                      <DatePicker showTime style={{ width: '100%' }} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={savingOtherExpense}>
                      保存
                    </Button>
                  </Form>
                </Modal>
              </>
            ),
          },
          {
            key: 'manual-incomes',
            label: '手工补录',
            children: (
              <>
                <Space style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openManualIncomeCreate}>
                    补录一笔收入
                  </Button>
                </Space>
                <Table {...manualIncomesTable.tableProps} rowKey="id">
                  <Table.Column
                    dataIndex="incomeItemId"
                    title="收入项目"
                    render={(value: string) => incomeItemName(value)}
                  />
                  <Table.Column dataIndex="period" title="归属月份" width={110} />
                  <Table.Column dataIndex="amount" title="金额（现金）" align="right" width={130} />
                  <Table.Column dataIndex="note" title="备注" />
                  <Table.Column<ManualIncomeRecord>
                    title="操作"
                    width={140}
                    render={(_, record) => (
                      <Space>
                        <Button size="small" onClick={() => openManualIncomeEdit(record)}>
                          编辑
                        </Button>
                        <DeleteButton
                          hideText
                          size="small"
                          resource="finance/manual-incomes"
                          recordItemId={record.id}
                          onSuccess={refetchStatements}
                        />
                      </Space>
                    )}
                  />
                </Table>

                <Modal
                  open={manualIncomeModalOpen}
                  title={editingManualIncome ? '编辑手工补录收入' : '补录一笔收入'}
                  onCancel={closeManualIncome}
                  footer={null}
                  destroyOnClose
                >
                  <Typography.Paragraph type="secondary">
                    只能选手工类收入项目；课时消费等自动取数项由系统按台账汇总，不能补录。
                  </Typography.Paragraph>
                  <Form
                    form={manualIncomeForm}
                    layout="vertical"
                    onFinish={submitManualIncome}
                  >
                    <Form.Item name="incomeItemId" label="收入项目（仅手工类）" rules={[{ required: true, message: '请选择收入项目' }]}>
                      <Select placeholder="自动取数项由系统汇总，不在此列" options={manualIncomeOptions} />
                    </Form.Item>
                    <Form.Item name="period" label="归属月份" rules={[{ required: true, message: '请选择归属月份' }]}>
                      <DatePicker picker="month" allowClear={false} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="amount" label="金额（现金）" rules={[{ required: true, message: '请输入金额' }]}>
                      <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="note" label="备注（可选）" rules={[{ max: 200 }]}>
                      <Input.TextArea rows={2} placeholder="例如：秋令营书本费" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={savingManualIncome}>
                      保存
                    </Button>
                  </Form>
                </Modal>
              </>
            ),
          },
        ]}
      />
    </Space>
  );
};
