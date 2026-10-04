import { useMemo, useState } from 'react';
import type { Dayjs } from 'dayjs';
import { List, useTable, DeleteButton } from '@refinedev/antd';
import {
  useCreate,
  useCustomMutation,
  useInvalidate,
  useList,
} from '@refinedev/core';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';

/**
 * 排课与上课确认（US-SC-01/02、US-CC-01/02/03）。
 *
 * - 列表走 GET /lessons（分页；老师筛选通过 meta.query 透传）
 * - 新增排课 POST /lessons：body 只有 学生/老师/课程/时间/是否赠送/备注，
 *   后端按「学生 + 老师 + 课程」自己定位报名关系，找不到会报「先报名」
 * - 确认 / 请假 / 取消走 POST /lessons/:id/confirm|leave|cancel（不收 body），
 *   每个动作先 Modal.confirm 说明后果；错误提示由 dataProvider 统一弹通知
 * - 删除 DELETE /lessons/:id（仅未确认的课），用 DeleteButton 自带确认
 */
type Lesson = {
  id: string;
  studentId: string;
  teacherId: string;
  courseTypeId: string;
  scheduledAt: string;
  isGift: boolean;
  status: 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED' | 'LEAVE';
  unitPriceSnapshot: string | null;
  note: string | null;
};

type OptionItem = { id: string; name: string };

type FormValues = {
  studentId: string;
  teacherId: string;
  courseTypeId: string;
  scheduledAt: Dayjs;
  isGift: boolean;
  note?: string;
};

const PAGE_OPTIONS = { pagination: { pageSize: 200 } };

const STATUS_LABEL: Record<Lesson['status'], string> = {
  SCHEDULED: '待上课',
  CONFIRMED: '已确认',
  CANCELLED: '已取消',
  LEAVE: '已请假',
};

const STATUS_COLOR: Record<Lesson['status'], string> = {
  SCHEDULED: 'blue',
  CONFIRMED: 'green',
  CANCELLED: 'default',
  LEAVE: 'orange',
};

export const LessonsPage = () => {
  const [form] = Form.useForm<FormValues>();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [teacherFilter, setTeacherFilter] = useState<string | undefined>();

  const invalidate = useInvalidate();
  const invalidateLessons = () =>
    invalidate({ resource: 'lessons', invalidates: ['list'] });

  const { tableProps } = useTable<Lesson>({
    resource: 'lessons',
    meta: { query: { teacherId: teacherFilter } },
  });

  // 列表只回 id，名称用各自列表接口在前端对上（不做任何业务计算）。
  const students = useList<OptionItem>({ resource: 'students', ...PAGE_OPTIONS });
  const teachers = useList<OptionItem>({ resource: 'teachers', ...PAGE_OPTIONS });
  const courseTypes = useList<OptionItem>({ resource: 'course-types', ...PAGE_OPTIONS });

  const studentName = useMemo(
    () => new Map((students.result.data ?? []).map((row) => [row.id, row.name])),
    [students.result.data],
  );
  const teacherName = useMemo(
    () => new Map((teachers.result.data ?? []).map((row) => [row.id, row.name])),
    [teachers.result.data],
  );
  const courseName = useMemo(
    () => new Map((courseTypes.result.data ?? []).map((row) => [row.id, row.name])),
    [courseTypes.result.data],
  );

  const { mutateAsync: createAsync } = useCreate();
  const { mutateAsync: actionAsync } = useCustomMutation();

  const openCreate = () => {
    setCreating(true);
    form.setFieldsValue({
      studentId: undefined,
      teacherId: undefined,
      courseTypeId: undefined,
      scheduledAt: undefined,
      isGift: false,
      note: '',
    });
  };

  const closeCreate = () => {
    setCreating(false);
    form.resetFields();
  };

  const onFinish = async (values: FormValues) => {
    setSaving(true);
    try {
      await createAsync({
        resource: 'lessons',
        values: {
          studentId: values.studentId,
          teacherId: values.teacherId,
          courseTypeId: values.courseTypeId,
          scheduledAt: values.scheduledAt.toISOString(),
          isGift: values.isGift,
          note: values.note || null,
        },
      });
      closeCreate();
    } finally {
      setSaving(false);
    }
  };

  /** 确认 / 请假 / 取消共用：先弹确认说明后果，再 POST 动作端点（不收 body）。 */
  const runAction = (lesson: Lesson, action: 'confirm' | 'leave' | 'cancel') => {
    const texts: Record<typeof action, { title: string; content: string; okText: string }> = {
      confirm: {
        title: '确认上课？',
        content:
          '确认后将立即按确认时刻的单价扣减该学生余额（赠送课扣赠送额度），此操作不会因之后取消而自动免除——取消/请假会以一笔反向流水回冲。',
        okText: '确认上课',
      },
      leave: {
        title: '标记请假？',
        content:
          '该课将记为请假。若此前从未确认（未扣费），不产生任何流水；若此前已确认扣费，会自动回冲一笔反向流水。',
        okText: '标记请假',
      },
      cancel: {
        title: '取消排课？',
        content:
          '该课将记为取消。若此前从未确认（未扣费），不产生任何流水；若此前已确认扣费，会自动回冲一笔反向流水。',
        okText: '取消排课',
      },
    };
    const t = texts[action];
    Modal.confirm({
      title: t.title,
      content: t.content,
      okText: t.okText,
      cancelText: '再想想',
      onOk: async () => {
        try {
          await actionAsync({
            url: `/lessons/${lesson.id}/${action}`,
            method: 'post',
            values: {},
          });
          invalidateLessons();
        } catch {
          // 错误提示已由通知统一弹出，这里吞掉避免弹层叠加。
        }
      },
    });
  };

  return (
    <List
      title="排课管理"
      headerButtons={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增排课
        </Button>
      }
    >
      <Space style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="按老师筛选"
          style={{ width: 200 }}
          value={teacherFilter}
          onChange={(value) => setTeacherFilter(value)}
          options={(teachers.result.data ?? []).map((row) => ({
            value: row.id,
            label: row.name,
          }))}
        />
      </Space>

      <Table {...tableProps} rowKey="id">
        <Table.Column
          dataIndex="scheduledAt"
          title="计划时间"
          width={160}
          render={(value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })}
        />
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
        <Table.Column
          dataIndex="isGift"
          title="赠送"
          width={80}
          render={(value: boolean) => (value ? <Tag color="purple">赠送</Tag> : '-')}
        />
        <Table.Column
          dataIndex="unitPriceSnapshot"
          title="单价快照"
          width={110}
          align="right"
          render={(value: string | null) => value ?? '未确认'}
        />
        <Table.Column
          dataIndex="status"
          title="状态"
          width={100}
          render={(value: Lesson['status']) => (
            <Tag color={STATUS_COLOR[value]}>{STATUS_LABEL[value]}</Tag>
          )}
        />
        <Table.Column<Lesson>
          title="操作"
          width={280}
          render={(_, record) => (
            <Space>
              {record.status === 'SCHEDULED' && (
                <Button size="small" type="primary" onClick={() => runAction(record, 'confirm')}>
                  确认
                </Button>
              )}
              {record.status !== 'CANCELLED' && record.status !== 'LEAVE' && (
                <Button size="small" onClick={() => runAction(record, 'leave')}>
                  请假
                </Button>
              )}
              {record.status !== 'CANCELLED' && (
                <Button size="small" onClick={() => runAction(record, 'cancel')}>
                  取消
                </Button>
              )}
              {record.status === 'SCHEDULED' && (
                <DeleteButton
                  hideText
                  size="small"
                  resource="lessons"
                  recordItemId={record.id}
                  onSuccess={invalidateLessons}
                />
              )}
            </Space>
          )}
        />
      </Table>

      <Modal open={creating} title="新增排课" onCancel={closeCreate} footer={null} destroyOnClose>
        <Typography.Paragraph type="secondary">
          后端按「学生 + 老师 + 课程」定位报名关系；三者还没有报名的会被拒绝，请先到「报名关系」新增。
          赠送课需要该报名关系下有可用的赠送额度。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="studentId" label="学生" rules={[{ required: true, message: '请选择学生' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择学生"
              options={(students.result.data ?? []).map((row) => ({
                value: row.id,
                label: row.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="teacherId" label="老师" rules={[{ required: true, message: '请选择老师' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择老师"
              options={(teachers.result.data ?? []).map((row) => ({
                value: row.id,
                label: row.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="courseTypeId"
            label="课程"
            rules={[{ required: true, message: '请选择课程' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择课程类型"
              options={(courseTypes.result.data ?? []).map((row) => ({
                value: row.id,
                label: row.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="scheduledAt"
            label="上课时间"
            rules={[{ required: true, message: '请选择日期时间' }]}
          >
            <DatePicker showSecond={false} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="isGift" label="赠送课" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={200} placeholder="可选，最长 200 字" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            保存
          </Button>
        </Form>
      </Modal>

      <Alert
        style={{ marginTop: 16 }}
        type="info"
        showIcon
        message="同一节课重复确认不会重复扣费；同一老师同一小时只允许排一节课（待上课或已确认）。"
      />
    </List>
  );
};
