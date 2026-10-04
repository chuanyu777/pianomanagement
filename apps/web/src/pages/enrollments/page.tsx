import { useMemo, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import { List, useTable, DeleteButton } from '@refinedev/antd';
import { useCreate, useList, useUpdate } from '@refinedev/core';
import {
  Button,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 报名与自定义课程价格（US-BD-05）。
 *
 * 一条报名关系 = 学生 + 老师 + 课程 + 该学生此课程的自定义单价。
 * 新增时从学生 / 老师 / 课程类型的列表接口拉选项；
 * 编辑只允许改「单价 + 生效区间」——身份三元组是唯一约束的键，起始余额是接续数据。
 * 金额直接提交数字，显示直接用后端返回的两位小数字符串。
 */
type Enrollment = {
  id: string;
  studentId: string;
  teacherId: string;
  courseTypeId: string;
  unitPrice: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  initialPaidBalance: string;
  initialGiftBalance: string;
};

type OptionItem = { id: string; name: string };

type FormValues = {
  studentId: string;
  teacherId: string;
  courseTypeId: string;
  unitPrice: number;
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs | null;
  initialPaidBalance?: number;
  initialGiftBalance?: number;
};

const PAGE_OPTIONS = { pagination: { pageSize: 200 } };

export const EnrollmentsPage = () => {
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<Enrollment | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const { tableProps } = useTable<Enrollment>({ resource: 'enrollments' });

  const students = useList<OptionItem>({ resource: 'students', ...PAGE_OPTIONS });
  const teachers = useList<OptionItem>({ resource: 'teachers', ...PAGE_OPTIONS });
  const courseTypes = useList<OptionItem>({ resource: 'course-types', ...PAGE_OPTIONS });

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

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: updateAsync } = useUpdate();

  const open = creating || editing !== null;

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({
      studentId: undefined,
      teacherId: undefined,
      courseTypeId: undefined,
      unitPrice: undefined,
      effectiveFrom: undefined,
      effectiveTo: null,
      initialPaidBalance: 0,
      initialGiftBalance: 0,
    });
  };

  const openEdit = (record: Enrollment) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      studentId: record.studentId,
      teacherId: record.teacherId,
      courseTypeId: record.courseTypeId,
      unitPrice: Number(record.unitPrice),
      effectiveFrom: dayjs(record.effectiveFrom.slice(0, 10)),
      effectiveTo: record.effectiveTo ? dayjs(record.effectiveTo.slice(0, 10)) : null,
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
      if (editing) {
        await updateAsync({
          resource: 'enrollments',
          id: editing.id,
          values: {
            unitPrice: values.unitPrice,
            effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
            effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
          },
        });
      } else {
        await createAsync({
          resource: 'enrollments',
          values: {
            studentId: values.studentId,
            teacherId: values.teacherId,
            courseTypeId: values.courseTypeId,
            unitPrice: values.unitPrice,
            effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
            effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
            initialPaidBalance: values.initialPaidBalance ?? 0,
            initialGiftBalance: values.initialGiftBalance ?? 0,
          },
        });
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <List
      title="报名关系"
      headerButtons={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增报名
        </Button>
      }
    >
      <Table {...tableProps} rowKey="id">
        <Table.Column
          dataIndex="studentId"
          title="学生"
          render={(value: string) => studentName.get(value) ?? value}
        />
        <Table.Column
          dataIndex="teacherId"
          title="老师"
          render={(value: string) => teacherName.get(value) ?? value}
        />
        <Table.Column
          dataIndex="courseTypeId"
          title="课程"
          render={(value: string) => courseName.get(value) ?? value}
        />
        <Table.Column dataIndex="unitPrice" title="单价" align="right" />
        <Table.Column
          dataIndex="effectiveFrom"
          title="生效起"
          render={(value: string) => value.slice(0, 10)}
        />
        <Table.Column
          dataIndex="effectiveTo"
          title="生效止"
          render={(value: string | null) => (value ? value.slice(0, 10) : '长期')}
        />
        <Table.Column
          title="操作"
          width={140}
          render={(_, record: Enrollment) => (
            <Space>
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
              <DeleteButton hideText size="small" resource="enrollments" recordItemId={record.id} />
            </Space>
          )}
        />
      </Table>

      <Modal
        open={open}
        title={editing ? '编辑报名关系（仅单价与生效区间）' : '新增报名'}
        onCancel={close}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          {editing
            ? '改单价只影响之后的课时，历史课的单价在确认时已锁定，不会被回写。'
            : '同一学生在同一老师同一课程下只能有一条报名关系；起始余额是从旧账接续的数据，之后只能靠台账流水变动。'}
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          {editing ? null : (
            <>
              <Form.Item name="studentId" label="学生" rules={[{ required: true, message: '请选择学生' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择学生"
                  loading={students.query.isLoading}
                  options={(students.result?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                />
              </Form.Item>
              <Form.Item name="teacherId" label="老师" rules={[{ required: true, message: '请选择老师' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择老师"
                  loading={teachers.query.isLoading}
                  options={(teachers.result?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                />
              </Form.Item>
              <Form.Item name="courseTypeId" label="课程" rules={[{ required: true, message: '请选择课程' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择课程类型"
                  loading={courseTypes.query.isLoading}
                  options={(courseTypes.result?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                />
              </Form.Item>
            </>
          )}
          <Form.Item
            name="unitPrice"
            label="课时单价"
            rules={[{ required: true, message: '请输入单价（必须大于 0）' }]}
            extra="该学生此课程的专属单价，与任何全局价格表无关"
          >
            <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="effectiveFrom" label="生效起" rules={[{ required: true, message: '请选择生效日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="effectiveTo" label="生效止（不填 = 长期）">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          {editing ? null : (
            <>
              <Form.Item
                name="initialPaidBalance"
                label="起始实收余额"
                extra="接续旧账用，可为负（学生本来就有欠费）；不接续就填 0"
              >
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="initialGiftBalance" label="起始赠送余额" extra="不接续就填 0">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>
    </List>
  );
};
