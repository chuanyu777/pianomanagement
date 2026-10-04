import { useState } from 'react';
import { useLogin } from '@refinedev/core';
import { Button, Card, Form, Input, Typography } from 'antd';

/**
 * 登录页（US-AC-03）。
 * 系统没有自助注册 —— 账号由店主在「账号管理」里建；
 * 空库时用 /bootstrap 建首位店主，所以这里放一个引导入口。
 */
export const LoginPage = () => {
  const { mutate: login } = useLogin();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 24 }}>
          琴行管理系统
        </Typography.Title>
        <Form
          layout="vertical"
          onFinish={(values) => {
            setLoading(true);
            login(values, {
              onError: (err) => {
                setError(err?.message ?? '登录失败');
                setLoading(false);
              },
              onSuccess: () => {
                setError(null);
                setLoading(false);
              },
            });
          }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoComplete="username" placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" placeholder="密码" />
          </Form.Item>
          {error && (
            <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12 }}>
              {error}
            </Typography.Text>
          )}
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, textAlign: 'center' }}>
          第一次使用？
          <a href="/bootstrap">创建店主账号</a>
        </Typography.Paragraph>
      </Card>
    </div>
  );
};
