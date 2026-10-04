import { useState } from 'react';
import { useCreate, useCustomMutation, useInvalidate, useList, useUpdate } from '@refinedev/core';
import { DeleteButton } from '@refinedev/antd';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 收支项目清单（US-BD-08）：收入项 / 支出项 / 工资代扣项三类。
 *
 * 三类接口在 items 的三个子路径下（GET/POST/PATCH/DELETE /items/income 等），
 * resource 直接写 'items/income' 这类带子路径的名字，dataProvider 拼 /${resource}。
 * 列表接口不分页，直接返回数组。
 *
 * 自动取数项（autoSource 非空）由收支表自动汇总，不允许手工记账引用；
 * 删除由后端做引用检查，被引用的项会被阻止，引导改用「停用」。
 */
type ItemRow = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  isDefault?: boolean;
  autoSource?: string | null;
};

type FormValues = {
  name: string;
  sortOrder: number;
  isActive: boolean;
  autoSource?: string;
};

const AUTO_SOURCE_LABEL: Record<string, string> = {
  LESSON_CONSUMPTION: '课时消费',
  PAYMENT: '收款',
  REFUND_FEE: '退费手续费',
  REFUND_PAID: '退费支出',
  PAYROLL_ACCRUED: '工资计提',
  PAYROLL_CASH: '工资实发',
  GIFT_COST: '赠课成本',
  PROFIT_SHARE: '利润分配',
};

const AUTO_SOURCE_OPTIONS = Object.entries(AUTO_SOURCE_LABEL).map(([value, label]) => ({ value, label }));

const SEED_URL = '/items/seed-defaults';

function ItemSection({
  resource,
  title,
  withAutoSource,
}: {
  resource: 'items/income' | 'items/expense' | 'items/deduction';
  title: string;
  withAutoSource: boolean;
}) {
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<ItemRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const { result, query } = useList<ItemRow>({ resource });
  const rows = result.data ?? [];

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: updateAsync } = useUpdate();

  const open = creating || editing !== null;

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({ name: '', sortOrder: 0, isActive: true, autoSource: '' });
  };

  const openEdit = (record: ItemRow) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      sortOrder: record.sortOrder,
      isActive: record.isActive,
      autoSource: record.autoSource ?? '',
    });
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    form.resetFields();
  };

  const onFinish = async (values: FormValues) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        sortOrder: values.sortOrder,
        isActive: values.isActive,
        ...(withAutoSource ? { autoSource: values.autoSource ? values.autoSource : null } : {}),
      };
      if (editing) {
        await updateAsync({ resource, id: editing.id, values: payload });
      } else {
        await createAsync({ resource, values: payload });
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (record: ItemRow, next: boolean) => {
    await updateAsync({ resource, id: record.id, values: { isActive: next } });
  };

  return (
    <Card size="small" title={title}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        size="small"
        style={{ marginBottom: 12 }}
        onClick={openCreate}
      >
        新增
      </Button>
      <Table rowKey="id" dataSource={rows} loading={query.isLoading} pagination={false} size="small">
        <Table.Column dataIndex="name" title="名称" />
        {withAutoSource ? (
          <Table.Column
            dataIndex="autoSource"
            title="取数方式"
            width={160}
            render={(value: string | null) =>
              value ? <Tag color="blue">{AUTO_SOURCE_LABEL[value] ?? value}</Tag> : <Tag>手工记账</Tag>
            }
          />
        ) : null}
        {withAutoSource ? (
          <Table.Column
            dataIndex="isDefault"
            title="默认模板"
            width={90}
            render={(value: boolean | undefined) => (value ? <Tag color="green">内置</Tag> : null)}
          />
        ) : null}
        <Table.Column dataIndex="sortOrder" title="排序" width={80} align="right" />
        <Table.Column
          dataIndex="isActive"
          title="启用"
          width={80}
          render={(value: boolean, record: ItemRow) => (
            <Switch size="small" checked={value} onChange={(next) => toggleActive(record, next)} />
          )}
        />
        <Table.Column
          title="操作"
          width={120}
          render={(_, record: ItemRow) => (
            <Space>
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
              <DeleteButton hideText size="small" resource={resource} recordItemId={record.id} />
            </Space>
          )}
        />
      </Table>

      <Modal
        open={open}
        title={editing ? `编辑：${editing.name}` : `新增${title.replace(/清单|项$/, '')}`}
        onCancel={close}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          被记账或工资表引用的项目删除时会被后端阻止，请改用「停用」保留历史口径。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }, { max: 32 }]}>
            <Input placeholder="项目名称" />
          </Form.Item>
          {withAutoSource ? (
            <Form.Item name="autoSource" label="取数方式" extra="自动取数项由收支表自动汇总，手工项目才允许选择记账">
              <Select
                allowClear
                placeholder="手工记账（或选择自动取数来源）"
                options={[{ value: '', label: '手工记账' }, ...AUTO_SOURCE_OPTIONS]}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="sortOrder" label="排序（小的在前）" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="isActive" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}

export const ItemsPage = () => {
  const { mutateAsync: seedAsync } = useCustomMutation<{ income: number; expense: number; deduction: number }>();
  const invalidate = useInvalidate();
  const [seeding, setSeeding] = useState(false);

  const seedDefaults = () => {
    Modal.confirm({
      title: '种入默认收支项目？',
      content: '会按默认模板幂等补齐收入 / 支出 / 代扣三类项目，已存在的不会重复创建。',
      okText: '种入',
      onOk: async () => {
        setSeeding(true);
        try {
          const { data } = await seedAsync({ url: SEED_URL, method: 'post', values: {} });
          invalidate({ resource: 'items/income', invalidates: ['list'] });
          invalidate({ resource: 'items/expense', invalidates: ['list'] });
          invalidate({ resource: 'items/deduction', invalidates: ['list'] });
          Modal.success({
            title: '默认项目已就绪',
            content: `本次新建：收入 ${data.income} 项、支出 ${data.expense} 项、代扣 ${data.deduction} 项。`,
          });
        } finally {
          setSeeding(false);
        }
      },
    });
  };

  return (
    <div>
      <Typography.Title level={4}>收支项目</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="收入 / 支出 / 代扣三类项目的清单维护；新机构可先用「种入默认模板」一键补齐常用项目，再按需增改。"
        action={
          <Button size="small" loading={seeding} onClick={seedDefaults}>
            种入默认模板
          </Button>
        }
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <ItemSection resource="items/income" title="收入项清单" withAutoSource />
        </Col>
        <Col xs={24} xl={8}>
          <ItemSection resource="items/expense" title="支出项清单" withAutoSource />
        </Col>
        <Col xs={24} xl={8}>
          <ItemSection resource="items/deduction" title="工资代扣项清单" withAutoSource={false} />
        </Col>
      </Row>
    </div>
  );
};
