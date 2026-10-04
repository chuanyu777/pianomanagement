import { useState } from 'react';
import { List, useTable, DeleteButton } from '@refinedev/antd';
import { useCreate, useUpdate } from '@refinedev/core';
import { Button, Form, Input, InputNumber, Modal, Space, Switch, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 课程类型维护（US-BD-01）。
 *
 * 这一页是其它基础资料页（老师 / 学生 / 报名 / 收支项目）的**写法模板**：
 * - 列表用 useTable（分页、排序、筛选都走 Refine 的统一约定）
 * - 新增和编辑共用一个 Modal + Form，用 useCreate / useUpdate 直接提交
 * - 删除用 DeleteButton（会弹确认）
 *
 * 权限由后端把守（整块仅店主），前端不做重复判断；
 * 403 / 409 的提示由 dataProvider 统一抛出、AntD 弹通知。
 */
type CourseType = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
};

type FormValues = { name: string; sortOrder: number; isActive: boolean };

export const CourseTypesList = () => {
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<CourseType | null>(null);
  const [creating, setCreating] = useState(false);

  const { tableProps } = useTable<CourseType>({
    resource: 'course-types',
    sorters: { initial: [{ field: 'sortOrder', order: 'asc' }] },
  });

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: updateAsync } = useUpdate();
  const [saving, setSaving] = useState(false);

  const open = creating || editing !== null;

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({ name: '', sortOrder: 0, isActive: true });
  };

  const openEdit = (record: CourseType) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      sortOrder: record.sortOrder,
      isActive: record.isActive,
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
      await submit(values);
    } finally {
      setSaving(false);
    }
  };

  const submit = async (values: FormValues) => {
    if (editing) {
      await updateAsync({ resource: 'course-types', id: editing.id, values });
    } else {
      await createAsync({ resource: 'course-types', values });
    }
    close();
  };

  return (
    <List
      title="课程类型"
      headerButtons={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增
        </Button>
      }
    >
      <Table {...tableProps} rowKey="id">
        <Table.Column dataIndex="name" title="名称" />
        <Table.Column dataIndex="sortOrder" title="排序" width={90} align="right" />
        <Table.Column
          dataIndex="isActive"
          title="启用"
          width={90}
          render={(value: boolean) => (value ? '是' : '否')}
        />
        <Table.Column
          title="操作"
          width={140}
          render={(_, record: CourseType) => (
            <Space>
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
              <DeleteButton hideText size="small" resource="course-types" recordItemId={record.id} />
            </Space>
          )}
        />
      </Table>

      <Modal
        open={open}
        title={editing ? `编辑：${editing.name}` : '新增课程类型'}
        onCancel={close}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          已被排课或报名关系引用的课程类型，删除时会被后端阻止并提示原因。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }, { max: 64 }]}>
            <Input placeholder="例如：主课 / 陪练课 / 乐理课" />
          </Form.Item>
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
    </List>
  );
};
