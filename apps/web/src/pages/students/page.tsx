import { useState } from 'react';
import { List, useTable, DeleteButton } from '@refinedev/antd';
import { useCreate, useUpdate } from '@refinedev/core';
import { Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 学生档案（US-BD-04）。
 * gradeLevel 是 1~10 的教学分级，仅作参考，不参与定价；
 * 状态流转（在读 / 暂停 / 退学）在编辑表单里改。
 * 删除由后端做引用检查，被业务数据引用的学生会被阻止并提示原因。
 */
type Student = {
  id: string;
  name: string;
  gradeLevel: number;
  status: 'ENROLLED' | 'PAUSED' | 'WITHDRAWN';
  wantsRefund: boolean;
  note: string | null;
};

type FormValues = {
  name: string;
  gradeLevel: number;
  status: Student['status'];
  wantsRefund: boolean;
  note?: string;
};

const STATUS_LABEL: Record<Student['status'], string> = {
  ENROLLED: '在读',
  PAUSED: '暂停',
  WITHDRAWN: '退学',
};

const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as Student['status'][]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

export const StudentsPage = () => {
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<Student | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const { tableProps } = useTable<Student>({ resource: 'students' });

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: updateAsync } = useUpdate();

  const open = creating || editing !== null;

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({ name: '', gradeLevel: 1, status: 'ENROLLED', wantsRefund: false, note: '' });
  };

  const openEdit = (record: Student) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      gradeLevel: record.gradeLevel,
      status: record.status,
      wantsRefund: record.wantsRefund,
      note: record.note ?? '',
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
        gradeLevel: values.gradeLevel,
        status: values.status,
        wantsRefund: values.wantsRefund,
        note: values.note ? values.note : null,
      };
      if (editing) {
        await updateAsync({ resource: 'students', id: editing.id, values: payload });
      } else {
        await createAsync({ resource: 'students', values: payload });
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <List
      title="学生档案"
      headerButtons={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增
        </Button>
      }
    >
      <Table {...tableProps} rowKey="id">
        <Table.Column dataIndex="name" title="姓名" />
        <Table.Column dataIndex="gradeLevel" title="学习级别" width={100} align="right" />
        <Table.Column
          dataIndex="status"
          title="状态"
          width={90}
          render={(value: Student['status']) => STATUS_LABEL[value]}
        />
        <Table.Column
          dataIndex="wantsRefund"
          title="退费意向"
          width={90}
          render={(value: boolean) => (value ? '是' : '否')}
        />
        <Table.Column dataIndex="note" title="备注" ellipsis render={(value: string | null) => value ?? '—'} />
        <Table.Column
          title="操作"
          width={140}
          render={(_, record: Student) => (
            <Space>
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
              <DeleteButton hideText size="small" resource="students" recordItemId={record.id} />
            </Space>
          )}
        />
      </Table>

      <Modal
        open={open}
        title={editing ? `编辑：${editing.name}` : '新增学生'}
        onCancel={close}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          学习级别只作教学分级参考，不参与任何定价；退费流程请在退费模块走，不要直接把状态改成退学。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 32 }]}>
            <Input placeholder="学生姓名" />
          </Form.Item>
          <Form.Item name="gradeLevel" label="学习级别（1~10）" rules={[{ required: true }]}>
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item name="wantsRefund" label="有退费意向" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="note" label="备注（可不填）">
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>
    </List>
  );
};
