import { useState } from 'react';
import { useCustom } from '@refinedev/core';
import { Card, Col, Row, Spin, Statistic, Table, Typography, DatePicker, Alert, Empty } from 'antd';
import dayjs from 'dayjs';
import { currentPeriod } from '../../period';

/**
 * 经营总览（US-OV-01 … 04）。
 * 数据来自 GET /overview?period=YYYY-MM，一次给四块：指标卡 / 构成 / 趋势 / 利润分配。
 */
type OverviewCard = { key: string; label: string; current: string; ytd: string };
type Slice = { items: { name: string; amount: string }[]; total: string };
type Overview = {
  period: string;
  cards: OverviewCard[];
  composition: { income: Slice; expense: Slice };
  trend: { period: string; profit: string }[];
  profitShare: { totalProfit: string; shares: { name: string; ratio: string; amount: string }[] };
};

export const DashboardPage = () => {
  const [period, setPeriod] = useState(currentPeriod());
  const { result, query } = useCustom<Overview>({
    url: `/overview?period=${period}`,
    method: 'get',
    queryOptions: { enabled: Boolean(period) },
  });

  if (query.isLoading) return <Spin />;
  if (query.isError) return <Alert type="error" message={String(query.error)} showIcon />;
  const overview = result?.data;
  if (!overview) return <Empty description="暂无数据" />;

  const { cards, composition, trend, profitShare } = overview;

  return (
    <div>
      <Typography.Title level={4}>经营总览</Typography.Title>

      <DatePicker
        picker="month"
        value={dayjs(period)}
        onChange={(value) => setPeriod(value ? value.format('YYYY-MM') : currentPeriod())}
        allowClear={false}
        style={{ marginBottom: 16 }}
      />

      <Row gutter={[16, 16]}>
        {cards.map((card) => (
          <Col key={card.key} xs={12} md={8} xl={4}>
            <Card size="small">
              <Statistic title={card.label} value={card.current} precision={2} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                本年累计 {card.ytd}
              </Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="收入构成（本月）">
            <CompositionTable slice={composition.income} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="支出构成（本月，经营口径）">
            <CompositionTable slice={composition.expense} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="近 12 个月盈利趋势（只含有数据的月份）">
            <Table
              size="small"
              rowKey="period"
              pagination={false}
              dataSource={trend}
              columns={[
                { title: '月份', dataIndex: 'period' },
                { title: '盈利', dataIndex: 'profit', align: 'right' as const },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title={`利润分配（本月，来自上月盈利 ${profitShare.totalProfit}）`}>
            {profitShare.shares.length === 0 ? (
              <Empty description="尚未配置利润分配人（机构设置里配）" />
            ) : (
              <Table
                size="small"
                rowKey="name"
                pagination={false}
                dataSource={profitShare.shares}
                columns={[
                  { title: '分配人', dataIndex: 'name' },
                  {
                    title: '比例',
                    dataIndex: 'ratio',
                    align: 'right' as const,
                    render: (v: string) => `${(Number(v) * 100).toFixed(2)}%`,
                  },
                  { title: '金额', dataIndex: 'amount', align: 'right' as const },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

function CompositionTable({ slice }: { slice: Slice }) {
  if (slice.items.length === 0) return <Empty description="本月没有数据" />;
  return (
    <Table
      size="small"
      rowKey="name"
      pagination={false}
      dataSource={slice.items}
      footer={() => `合计 ${slice.total}`}
      columns={[
        { title: '项目', dataIndex: 'name' },
        { title: '金额', dataIndex: 'amount', align: 'right' as const },
      ]}
    />
  );
}
