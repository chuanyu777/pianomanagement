import { useEffect, useMemo, useRef, useState } from 'react';
import { useCustom, useCustomMutation, useList } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Steps,
  Typography,
} from 'antd';

/**
 * 初始化向导（US-IW-01 / US-IW-02）。
 *
 * - 顶部 8 步进度来自 GET /onboarding/status（每步 label + done）。
 * - 「录入接续数据」：三个机构级数字（现金期初 / 上月盈利 / 上月应发工资）走
 *   PUT /onboarding/carry-over（data-provider 的 update 是 PATCH，PUT 一律用
 *   useCustomMutation(method: 'put')）；学生起始余额为可选区，选学生后按其报名关系逐条填。
 * - 「完成初始化」POST /onboarding/complete：缺现金期初 / 上月盈利 / 上月应发工资时
 *   后端返回 400 并提示「首月报表将不正确」——这是在告诉店主后果，必须原样展示，不能吞掉。
 * - 机构信息 PATCH /organization、利润分配人 GET/PUT /organization/profit-shares、
 *   默认收支项目 POST /items/seed-defaults。
 * - 已 completed 时展示完成状态，且所有卡片仍可继续修改。
 */
type OnboardingStep = { key: string; label: string; done: boolean };
type OnboardingStatus = {
  completed: boolean;
  completedAt: string | null;
  steps: OnboardingStep[];
};

type Organization = {
  name: string;
  city: string | null;
  reporter: string | null;
  initialCashBalance: string;
  previousMonthProfit: string;
  previousMonthPayroll: string;
};

type ProfitShare = { id: string; name: string; ratio: string };
type OptionItem = { id: string; name: string };
type Student = { id: string; name: string };
type Enrollment = {
  id: string;
  studentId: string;
  teacherId: string;
  courseTypeId: string;
  unitPrice: string;
  initialPaidBalance: string;
  initialGiftBalance: string;
};

type CarryOverFormValues = {
  initialCashBalance?: number | null;
  previousMonthProfit?: number | null;
  previousMonthPayroll?: number | null;
};
type OrgFormValues = { name: string; city?: string; reporter?: string };
type SharesFormValues = { rules: { name: string; ratio: number }[] };

type BalanceEntry = { paid: number | null; gift: number | null; price: number | null };

type CarryOverPayload = {
  initialCashBalance?: number;
  previousMonthProfit?: number;
  previousMonthPayroll?: number;
  students?: {
    studentId: string;
    enrollments: {
      enrollmentId: string;
      initialPaidBalance: number;
      initialGiftBalance: number;
      unitPrice: number;
    }[];
  }[];
};

const PAGE_OPTIONS = { pagination: { pageSize: 200 } };

/** InputNumber 清空时给 null，提交前统一转成「不传」。 */
const toNumber = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const OnboardingPage = () => {
  const [carryOverForm] = Form.useForm<CarryOverFormValues>();
  const [orgForm] = Form.useForm<OrgFormValues>();
  const [sharesForm] = Form.useForm<SharesFormValues>();

  const statusQuery = useCustom<OnboardingStatus>({ url: '/onboarding/status', method: 'get' });
  const orgQuery = useCustom<Organization>({ url: '/organization', method: 'get' });
  const sharesQuery = useCustom<ProfitShare[]>({
    url: '/organization/profit-shares',
    method: 'get',
  });

  const students = useList<Student>({ resource: 'students', ...PAGE_OPTIONS });
  const enrollments = useList<Enrollment>({ resource: 'enrollments', ...PAGE_OPTIONS });
  const teachers = useList<OptionItem>({ resource: 'teachers', ...PAGE_OPTIONS });
  const courseTypes = useList<OptionItem>({ resource: 'course-types', ...PAGE_OPTIONS });

  // PUT /onboarding/carry-over、POST /onboarding/complete、
  // PATCH /organization、PUT /organization/profit-shares、POST /items/seed-defaults
  const { mutateAsync: carryOverAsync } = useCustomMutation();
  const { mutateAsync: completeAsync } = useCustomMutation();
  const { mutateAsync: orgAsync } = useCustomMutation();
  const { mutateAsync: sharesAsync } = useCustomMutation<ProfitShare[]>();
  const { mutateAsync: seedAsync } =
    useCustomMutation<{ income: number; expense: number; deduction: number }>();

  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [balanceValues, setBalanceValues] = useState<Record<string, BalanceEntry>>({});
  const [savingCarryOver, setSavingCarryOver] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [savingOrg, setSavingOrg] = useState(false);
  const [savingShares, setSavingShares] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const org = orgQuery.result?.data;
  const shares = sharesQuery.result?.data;

  const studentName = useMemo(
    () => new Map((students.result?.data ?? []).map((row) => [row.id, row.name])),
    [students.result?.data],
  );
  const teacherName = useMemo(
    () => new Map((teachers.result?.data ?? []).map((row) => [row.id, row.name])),
    [teachers.result?.data],
  );
  const courseName = useMemo(
    () => new Map((courseTypes.result?.data ?? []).map((row) => [row.id, row.name])),
    [courseTypes.result?.data],
  );

  // 机构信息表单：数据到达后回填
  useEffect(() => {
    if (org) {
      orgForm.setFieldsValue({
        name: org.name,
        city: org.city ?? undefined,
        reporter: org.reporter ?? undefined,
      });
    }
  }, [org, orgForm]);

  // 接续数据三个数字：只在首次加载时用机构当前值回填，之后以用户输入为准
  const carryOverPrefilled = useRef(false);
  useEffect(() => {
    if (org && !carryOverPrefilled.current) {
      carryOverPrefilled.current = true;
      carryOverForm.setFieldsValue({
        initialCashBalance: Number(org.initialCashBalance),
        previousMonthProfit: Number(org.previousMonthProfit),
        previousMonthPayroll: Number(org.previousMonthPayroll),
      });
    }
  }, [org, carryOverForm]);

  // 利润分配表单：数据每次到达（含保存后刷新）都回填
  useEffect(() => {
    if (shares) {
      sharesForm.setFieldsValue({
        rules: shares.map((row) => ({ name: row.name, ratio: Number(row.ratio) })),
      });
    }
  }, [shares, sharesForm]);

  // 选中的学生有报名关系数据时，给每条报名预填当前值
  useEffect(() => {
    if (selectedStudentIds.length === 0) return;
    const rows = enrollments.result?.data ?? [];
    setBalanceValues((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const row of rows) {
        if (selectedStudentIds.includes(row.studentId) && !next[row.id]) {
          next[row.id] = {
            paid: Number(row.initialPaidBalance),
            gift: Number(row.initialGiftBalance),
            price: Number(row.unitPrice),
          };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedStudentIds, enrollments.result?.data]);

  const updateBalance = (enrollmentId: string, patch: Partial<BalanceEntry>) => {
    setBalanceValues((prev) => {
      const current = prev[enrollmentId] ?? { paid: null, gift: null, price: null };
      return { ...prev, [enrollmentId]: { ...current, ...patch } };
    });
  };

  const onSaveCarryOver = async () => {
    let values: CarryOverFormValues;
    try {
      values = await carryOverForm.validateFields();
    } catch {
      return;
    }

    const payload: CarryOverPayload = {};
    const cash = toNumber(values.initialCashBalance);
    const profit = toNumber(values.previousMonthProfit);
    const payroll = toNumber(values.previousMonthPayroll);
    if (cash !== undefined) payload.initialCashBalance = cash;
    if (profit !== undefined) payload.previousMonthProfit = profit;
    if (payroll !== undefined) payload.previousMonthPayroll = payroll;

    const studentRows = enrollments.result?.data ?? [];
    const studentsPayload = selectedStudentIds
      .map((studentId) => ({
        studentId,
        enrollments: studentRows
          .filter((row) => row.studentId === studentId)
          .map((row) => {
            const entry = balanceValues[row.id];
            return {
              enrollmentId: row.id,
              initialPaidBalance: toNumber(entry?.paid) ?? 0,
              initialGiftBalance: toNumber(entry?.gift) ?? 0,
              unitPrice: toNumber(entry?.price) ?? Number(row.unitPrice),
            };
          }),
      }))
      .filter((student) => student.enrollments.length > 0);
    if (studentsPayload.length > 0) payload.students = studentsPayload;

    if (Object.keys(payload).length === 0) {
      message.warning('还没有填写任何接续数据');
      return;
    }

    setSavingCarryOver(true);
    try {
      await carryOverAsync({ url: '/onboarding/carry-over', method: 'put', values: payload });
      message.success('接续数据已保存');
      statusQuery.query.refetch();
    } finally {
      setSavingCarryOver(false);
    }
  };

  const onComplete = async () => {
    setCompleting(true);
    setCompleteError(null);
    try {
      await completeAsync({ url: '/onboarding/complete', method: 'post', values: {} });
      message.success('初始化已完成');
      statusQuery.query.refetch();
    } catch (error) {
      // 400 的提示（如「首月报表将不正确」）必须原样展示给店主，不能吞掉
      setCompleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompleting(false);
    }
  };

  const onSaveOrg = async () => {
    let values: OrgFormValues;
    try {
      values = await orgForm.validateFields();
    } catch {
      return;
    }
    setSavingOrg(true);
    try {
      await orgAsync({
        url: '/organization',
        method: 'patch',
        values: {
          name: values.name.trim(),
          city: values.city?.trim() || undefined,
          reporter: values.reporter?.trim() || undefined,
        },
      });
      message.success('机构信息已保存');
      orgQuery.query.refetch();
      statusQuery.query.refetch();
    } finally {
      setSavingOrg(false);
    }
  };

  const onSaveShares = async () => {
    let values: SharesFormValues;
    try {
      values = await sharesForm.validateFields();
    } catch {
      return;
    }
    setSavingShares(true);
    try {
      const { data } = await sharesAsync({
        url: '/organization/profit-shares',
        method: 'put',
        values: {
          rules: values.rules.map((rule) => ({ name: rule.name.trim(), ratio: rule.ratio })),
        },
      });
      message.success('利润分配已保存');
      sharesForm.setFieldsValue({
        rules: (data ?? []).map((row) => ({ name: row.name, ratio: Number(row.ratio) })),
      });
    } finally {
      setSavingShares(false);
    }
  };

  const onSeedDefaults = () => {
    Modal.confirm({
      title: '种入默认收支项目？',
      content: '会按默认模板幂等补齐收入 / 支出 / 代扣三类项目，已存在的不会重复创建。',
      okText: '种入',
      onOk: async () => {
        setSeeding(true);
        try {
          const { data } = await seedAsync({
            url: '/items/seed-defaults',
            method: 'post',
            values: {},
          });
          message.success(
            `本次新建：收入 ${data.income} 项、支出 ${data.expense} 项、代扣 ${data.deduction} 项。`,
          );
          statusQuery.query.refetch();
        } finally {
          setSeeding(false);
        }
      },
    });
  };

  if (statusQuery.query.isLoading || orgQuery.query.isLoading) return <Spin />;
  if (statusQuery.query.isError)
    return <Alert type="error" showIcon message={String(statusQuery.query.error)} />;

  const status = statusQuery.result?.data;
  if (!status) return <Empty description="暂无数据" />;

  return (
    <div>
      <Typography.Title level={4}>初始化向导</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="按 8 步把琴行的基础数据和首月接续数据录入系统，全部就绪后点「完成初始化」。完成后各项内容仍可继续修改。"
      />

      <Card size="small" style={{ marginBottom: 16 }}>
        {status.completed && (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={`初始化已完成${status.completedAt ? `（${status.completedAt.slice(0, 10)}）` : ''}，以下内容仍可继续修改。`}
          />
        )}
        <Steps
          size="small"
          items={status.steps.map((step) => ({
            title: step.label,
            status: step.done ? ('finish' as const) : ('wait' as const),
          }))}
        />
        <Divider style={{ margin: '16px 0' }} />
        <Space wrap>
          <Button type="primary" loading={completing} onClick={onComplete}>
            完成初始化
          </Button>
          <Typography.Text type="secondary">
            缺少现金期初 / 上月盈利 / 上月应发工资时，完成会被拒绝并说明「首月报表将不正确」。
          </Typography.Text>
        </Space>
        {completeError && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message={completeError} />
        )}
      </Card>

      <Card size="small" title="录入接续数据（首月）" style={{ marginBottom: 16 }}>
        <Form form={carryOverForm} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="initialCashBalance" label="现金结余期初" extra="开始用系统时账上现有的现金">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="previousMonthProfit" label="上月盈利" extra="用于本月的利润分配">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="previousMonthPayroll" label="上月应发工资" extra="会在本月以现金支出">
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          学生起始余额（可选）：选学生后按其报名关系逐条填起始实收 / 赠送余额与单价；改过的以后端保存为准。
        </Typography.Paragraph>
        <Select
          mode="multiple"
          showSearch
          optionFilterProp="label"
          placeholder="选择学生（可多选）"
          style={{ width: '100%', maxWidth: 480 }}
          loading={students.query.isLoading}
          value={selectedStudentIds}
          onChange={setSelectedStudentIds}
          allowClear
          options={(students.result?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
        />

        {selectedStudentIds.map((studentId) => {
          const rows = (enrollments.result?.data ?? []).filter((row) => row.studentId === studentId);
          return (
            <Card
              key={studentId}
              type="inner"
              size="small"
              title={studentName.get(studentId) ?? studentId}
              style={{ marginTop: 12 }}
            >
              {rows.length === 0 ? (
                <Empty description="该学生暂无报名关系，请先到「报名关系」里新增" />
              ) : (
                rows.map((row) => {
                  const entry = balanceValues[row.id];
                  const label = `${courseName.get(row.courseTypeId) ?? row.courseTypeId}（老师：${teacherName.get(row.teacherId) ?? row.teacherId}）`;
                  return (
                    <div key={row.id} style={{ marginBottom: 12 }}>
                      <Typography.Text strong>{label}</Typography.Text>
                      <Row gutter={12} style={{ marginTop: 4 }}>
                        <Col xs={24} md={8}>
                          <InputNumber
                            min={0}
                            precision={2}
                            style={{ width: '100%' }}
                            addonBefore="起始实收"
                            value={entry?.paid ?? null}
                            onChange={(value) => updateBalance(row.id, { paid: value })}
                          />
                        </Col>
                        <Col xs={24} md={8}>
                          <InputNumber
                            min={0}
                            precision={2}
                            style={{ width: '100%' }}
                            addonBefore="起始赠送"
                            value={entry?.gift ?? null}
                            onChange={(value) => updateBalance(row.id, { gift: value })}
                          />
                        </Col>
                        <Col xs={24} md={8}>
                          <InputNumber
                            min={0}
                            precision={2}
                            style={{ width: '100%' }}
                            addonBefore="单价"
                            value={entry?.price ?? null}
                            onChange={(value) => updateBalance(row.id, { price: value })}
                          />
                        </Col>
                      </Row>
                    </div>
                  );
                })
              )}
            </Card>
          );
        })}

        <Button
          type="primary"
          style={{ marginTop: 16 }}
          loading={savingCarryOver}
          onClick={onSaveCarryOver}
        >
          保存接续数据
        </Button>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card size="small" title="机构信息">
            <Form form={orgForm} layout="vertical">
              <Form.Item name="name" label="机构名称" rules={[{ required: true, message: '请输入机构名称' }]}>
                <Input maxLength={64} placeholder="例如：星光琴行" />
              </Form.Item>
              <Form.Item name="city" label="所在城市">
                <Input maxLength={64} />
              </Form.Item>
              <Form.Item name="reporter" label="制表人">
                <Input maxLength={32} />
              </Form.Item>
              <Button type="primary" block loading={savingOrg} onClick={onSaveOrg}>
                保存机构信息
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="利润分配人">
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              比例用小数填（0.15 = 15%），合计必须等于 100%，由后端校验。
            </Typography.Paragraph>
            <Form form={sharesForm} layout="vertical">
              <Form.List name="rules">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field) => (
                      <Space key={field.key} align="baseline" style={{ display: 'flex' }}>
                        <Form.Item name={[field.name, 'name']} rules={[{ required: true, message: '请输入姓名' }]}>
                          <Input placeholder="分配人" maxLength={32} style={{ width: 140 }} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'ratio']} rules={[{ required: true, message: '请输入比例' }]}>
                          <InputNumber min={0} max={1} step={0.05} placeholder="0.15" style={{ width: 120 }} />
                        </Form.Item>
                        <Button type="text" danger onClick={() => remove(field.name)}>
                          删除
                        </Button>
                      </Space>
                    ))}
                    <Button type="dashed" block onClick={() => add({ name: '', ratio: 0.5 })}>
                      添加分配人
                    </Button>
                  </>
                )}
              </Form.List>
              <Button type="primary" block style={{ marginTop: 12 }} loading={savingShares} onClick={onSaveShares}>
                保存利润分配
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="默认收支项目">
            <Typography.Paragraph type="secondary">
              一键按默认模板补齐收入 / 支出 / 代扣三类项目；操作是幂等的，已存在的不会重复创建。
            </Typography.Paragraph>
            <Button type="primary" loading={seeding} onClick={onSeedDefaults}>
              种入默认收支项目
            </Button>
          </Card>
        </Col>
      </Row>
    </div>
  );
};
