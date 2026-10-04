import { useState } from 'react';
import { Button, Card, Form, Input, Typography, message } from 'antd';
import { API_URL } from '../../data-provider';

/**
 * 首次引导：创建店主账号（US-IW-01 的前置）。
 * 只在空库时能用 —— 后端在已初始化时会返回 409，这里如实展示。
 */
export const BootstrapPage = () => {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: {
    username: string;
    password: string;
    displayName: string;
    organizationName?: string;
  }) => {
    setLoading(true);
    setError(null);
    const res = await fetch(`${API_URL}/bootstrap/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.message ?? `创建失败（${res.status}）`);
      return;
    }
    message.success('店主账号已创建，请用新账号登录');
    setDone(true);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
      }}
    >
      <Card style={{ width: 420 }}>
        <Typography.Title level={4} style={{ textAlign: 'center' }}>
          初始化琴行系统
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          创建第一个店主账号。这一步只在系统还是空的时候可用。
        </Typography.Paragraph>
        {done ? (
          <Typography.Paragraph style={{ textAlign: 'center' }}>
            创建成功，<a href="/login">去登录</a>
          </Typography.Paragraph>
        ) : (
          <Form layout="vertical" onFinish={onFinish}>
            <Form.Item name="organizationName" label="机构名称">
              <Input placeholder="例如：星光琴行" />
            </Form.Item>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input placeholder="3-32 位小写字母、数字" />
            </Form.Item>
            <Form.Item name="displayName" label="显示名" rules={[{ required: true }]}>
              <Input placeholder="例如：老板" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, min: 8 }]}>
              <Input.Password placeholder="至少 8 位 ASCII 字符" />
            </Form.Item>
            {error && (
              <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12 }}>
                {error}
              </Typography.Text>
            )}
            <Button type="primary" htmlType="submit" block loading={loading}>
              创建店主账号
            </Button>
            <Typography.Paragraph style={{ marginTop: 12, marginBottom: 0, textAlign: 'center' }}>
              <a href="/login">已有账号？去登录</a>
            </Typography.Paragraph>
          </Form>
        )}
      </Card>
    </div>
  );
};
