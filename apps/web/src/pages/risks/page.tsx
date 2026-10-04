import dayjs from 'dayjs';
import { useCustom } from '@refinedev/core';
import { Card, Space, Table, Tabs, Typography } from 'antd';

/**
 * 风险提醒（US-RA-01 / US-RA-02）。
 *
 * 欠费名单仅店主；沉睡名单店主与授课老师都可见 —— 权限由后端把守，
 * 401/403 由 dataProvider 统一抛出，前端不再判断角色。
 * 阈值天数从接口返回拿，不硬编码；欠费升序由后端排好，前端不重排。
 */
type UnpaidRow = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  courseTypeName: string;
  balance: string;
  totalBalance: string;
};

type SleepingStudent = {
  studentId: string;
  studentName: string;
  lastConfirmedAt: string | null;
  idleDays: number;
};

type SleepingList = {
  thresholdDays: number;
  sleeping: SleepingStudent[];
  never: SleepingStudent[];
};

const SleepingTable = ({ data, loading }: { data: SleepingStudent[]; loading: boolean }) => (
  <Table<SleepingStudent>
    rowKey="studentId"
    dataSource={data}
    loading={loading}
    pagination={false}
  >
    <Table.Column dataIndex="studentName" title="学生" />
    <Table.Column<SleepingStudent>
      title="最近确认上课时间"
      width={180}
      render={(_, record) =>
        record.lastConfirmedAt ? dayjs(record.lastConfirmedAt).format('YYYY-MM-DD HH:mm') : '—'
      }
    />
    <Table.Column
      dataIndex="idleDays"
      title="距今天数"
      align="right"
      width={110}
      render={(value: number) => `${value} 天`}
    />
  </Table>
);

export const RisksPage = () => {
  const unpaidQuery = useCustom<UnpaidRow[]>({
    url: '/risks/unpaid',
    method: 'get',
  });
  const sleepingQuery = useCustom<SleepingList>({
    url: '/risks/sleeping',
    method: 'get',
  });

  const sleeping = sleepingQuery.result.data;

  return (
    <Tabs
      items={[
        {
          key: 'unpaid',
          label: '欠费名单',
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                按欠费余额升序列出各报名的欠费情况（仅店主可见）。
              </Typography.Text>
              <Table<UnpaidRow>
                rowKey="enrollmentId"
                dataSource={unpaidQuery.result.data}
                loading={unpaidQuery.query.isLoading}
                pagination={false}
              >
                <Table.Column dataIndex="studentName" title="学生" />
                <Table.Column dataIndex="courseTypeName" title="课程" />
                <Table.Column dataIndex="balance" title="欠费余额" align="right" />
                <Table.Column dataIndex="totalBalance" title="合计余额（该生所有报名）" align="right" />
              </Table>
            </Space>
          ),
        },
        {
          key: 'sleeping',
          label: '沉睡学生',
          children: (
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                {sleeping
                  ? `超过 ${sleeping.thresholdDays} 天未确认上课的学生需要关注（店主与授课老师可见）。`
                  : '按最后一次确认上课的时间，找出长期没来上课的学生。'}
              </Typography.Text>
              <Card title="超过阈值未上课">
                <SleepingTable data={sleeping?.sleeping ?? []} loading={sleepingQuery.query.isLoading} />
              </Card>
              <Card title="从未确认过任何一节课">
                <SleepingTable data={sleeping?.never ?? []} loading={sleepingQuery.query.isLoading} />
              </Card>
            </Space>
          ),
        },
      ]}
    />
  );
};
