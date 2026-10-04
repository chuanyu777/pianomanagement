import { useState } from 'react';
import dayjs from 'dayjs';
import { useCustom } from '@refinedev/core';
import { Card, DatePicker, Space, Table, Typography } from 'antd';
import { currentPeriod } from '../../period';

/**
 * 经营分析（US-AN-01/02/03）。整块仅店主可见（后端 RolesGuard 把守）。
 *
 * 排行与名次全部由后端算好返回，前端不做任何算术、也不重排；
 * 趋势按老师分列展示（不画图），月份列为后端 points 里的 period。
 */
type TeacherRankingRow = {
  rank: number;
  teacherId: string;
  teacherName: string;
  performance: string;
  lessonCount: number;
};

type StudentRankingRow = {
  rank: number;
  studentId: string;
  studentName: string;
  consumption: string;
  lessonCount: number;
};

type TrendPoint = { period: string; performance: string };

type TeacherTrendSeries = {
  teacherId: string;
  teacherName: string;
  points: TrendPoint[];
};

const TrendTable = ({ data, loading }: { data: TeacherTrendSeries[]; loading: boolean }) => {
  // 每位老师的 points 长度与月份集合一致（后端补 0 不跳过），取第一位的月份做列
  const periods = data[0]?.points.map((point) => point.period) ?? [];

  return (
    <Table<TeacherTrendSeries>
      rowKey="teacherId"
      dataSource={data}
      loading={loading}
      pagination={false}
      scroll={{ x: 'max-content' }}
    >
      <Table.Column dataIndex="teacherName" title="老师" fixed="left" width={120} />
      {periods.map((period, index) => (
        <Table.Column<TeacherTrendSeries>
          key={period}
          title={period}
          align="right"
          render={(_, record) => record.points[index]?.performance ?? '—'}
        />
      ))}
    </Table>
  );
};

export const AnalyticsPage = () => {
  const [period, setPeriod] = useState(() => currentPeriod());

  const teacherRankingQuery = useCustom<TeacherRankingRow[]>({
    url: `/analytics/teacher-ranking?period=${period}`,
    method: 'get',
  });
  const studentRankingQuery = useCustom<StudentRankingRow[]>({
    url: `/analytics/student-ranking?period=${period}`,
    method: 'get',
  });
  const teacherTrendQuery = useCustom<TeacherTrendSeries[]>({
    url: `/analytics/teacher-trend?period=${period}&months=6`,
    method: 'get',
  });

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

      <Card title="教师业绩排行">
        <Table<TeacherRankingRow>
          rowKey="teacherId"
          dataSource={teacherRankingQuery.result?.data}
          loading={teacherRankingQuery.query.isLoading}
          pagination={false}
        >
          <Table.Column dataIndex="rank" title="名次" width={80} />
          <Table.Column dataIndex="teacherName" title="老师" />
          <Table.Column dataIndex="performance" title="业绩" align="right" />
          <Table.Column dataIndex="lessonCount" title="确认课时数" align="right" width={120} />
        </Table>
      </Card>

      <Card title="学生消费排行">
        <Table<StudentRankingRow>
          rowKey="studentId"
          dataSource={studentRankingQuery.result?.data}
          loading={studentRankingQuery.query.isLoading}
          pagination={false}
        >
          <Table.Column dataIndex="rank" title="名次" width={80} />
          <Table.Column dataIndex="studentName" title="学生" />
          <Table.Column dataIndex="consumption" title="消费" align="right" />
          <Table.Column dataIndex="lessonCount" title="确认课时数" align="right" width={120} />
        </Table>
      </Card>

      <Card title="教师业绩趋势（近 6 个月，金额为后端返回字符串）">
        <TrendTable
          data={teacherTrendQuery.result?.data ?? []}
          loading={teacherTrendQuery.query.isLoading}
        />
      </Card>
    </Space>
  );
};
