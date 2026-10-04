import { useState } from 'react';
import type { Dayjs } from 'dayjs';
import { List, useTable } from '@refinedev/antd';
import { useCreate, useUpdate } from '@refinedev/core';
import { Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 老师档案（US-BD-03）。
 *
 * 后端只有列表 / 新增 / 编辑，没有删除接口——老师被报名、排课引用后
 * 不能删，停用走编辑表单里的「状态 = 停用」。
 * 权限由后端把守（整块仅店主），403 提示由 dataProvider 统一抛出。
 */
type Teacher = {
  id: string;
  name: string;
  position: string | null;
  hiredAt: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  /** 课消奖比例 0~1（后端 Decimal，返回字符串，如 "0.1500"） */
  commissionRate: string | null;
  defaultBaseSalary: string | null;
};

type FormValues = {
  name: string;
  position?: string;
  hiredAt?: Dayjs | null;
  status: 'ACTIVE' | 'INACTIVE';
  commissionRate?: number | null;
  defaultBaseSalary?: number | null;
};

const STATUS_LABEL: Record<Teacher['status'], string> = {
  ACTIVE: '在职',
  INACTIVE: '停用',
};

export const TeachersPage = () => {
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<Teacher | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const { tableProps } = useTable<Teacher>({ resource: 'teachers' });

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: updateAsync } = useUpdate();

  const open = creating || editing !== null;

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({ name: '', position: '', hiredAt: null, status: 'ACTIVE' });
  };

  const openEdit = (record: Teacher) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      position: record.position ?? '',
      hiredAt: null,
      status: record.status,
      commissionRate: record.commissionRate === null ? undefined : Number(record.commissionRate),
      defaultBaseSalary:
        record.defaultBaseSalary === null ? undefined : Number(record.defaultBaseSalary),
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
        position: values.position ? values.position : null,
        hiredAt: values.hiredAt ? values.hiredAt.format('YYYY-MM-DD') : null,
        status: values.status,
        commissionRate: values.commissionRate ?? null,
        defaultBaseSalary: values.defaultBaseSalary ?? null,
      };
      if (editing) {
        await updateAsync({ resource: 'teachers', id: editing.id, values: payload });
      } else {
        await createAsync({ resource: 'teachers', values: payload });
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <List
      title="老师档案"
      headerButtons={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增
        </Button>
      }
    >
      <Table {...tableProps} rowKey="id">
        <Table.Column dataIndex="name" title="姓名" />
        <Table.Column dataIndex="position" title="岗位" render={(value: string | null) => value ?? '—'} />
        <Table.Column
          dataIndex="hiredAt"
          title="入职时间"
          render={(value: string | null) => (value ? value.slice(0, 10) : '—')}
        />
        <Table.Column
          dataIndex="status"
          title="状态"
          width={90}
          render={(value: Teacher['status']) => STATUS_LABEL[value]}
        />
        <Table.Column
          dataIndex="commissionRate"
          title="课消奖比例"
          render={(value: string | null) => (value === null ? '默认' : `${(Number(value) * 100).toFixed(1)}%`)}
        />
        <Table.Column
          dataIndex="defaultBaseSalary"
          title="基本工资默认值"
          render={(value: string | null) => (value === null ? '—' : value)}
        />
        <Table.Column
          title="操作"
          width={90}
          render={(_, record: Teacher) => (
            <Space>
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
            </Space>
          )}
        />
      </Table>

      <Modal
        open={open}
        title={editing ? `编辑：${editing.name}` : '新增老师'}
        onCancel={close}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          老师不能删除，只能停用；已停用的老师不能新建排课或报名关系。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 32 }]}>
            <Input placeholder="老师姓名" />
          </Form.Item>
          <Form.Item name="position" label="岗位（可不填）">
            <Input placeholder="例如：钢琴老师" maxLength={32} />
          </Form.Item>
          <Form.Item name="hiredAt" label="入职时间（可不填）">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'ACTIVE', label: '在职' },
                { value: 'INACTIVE', label: '停用' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="commissionRate"
            label="课消奖比例（0~1，不填取机构默认）"
            extra="0.15 表示 15%，留空则按机构默认比例计算"
          >
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} placeholder="例如 0.15" />
          </Form.Item>
          <Form.Item name="defaultBaseSalary" label="基本工资默认值（不填则不预设）">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="每月基本工资" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>
    </List>
  );
};
