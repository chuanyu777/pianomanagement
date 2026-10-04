import { List, useTable } from '@refinedev/antd';
import { useUpdate } from '@refinedev/core';
import { Modal, Space, Switch, Table, Tag, Typography } from 'antd';

/**
 * 账号管理（只读列表 + 启停）。
 *
 * 账号的创建走登录页的首次引导 / 机构初始化，这里只负责看和停用；
 * 不提供删除 —— 停用足以挡住登录，删除会让历史台账失去操作人线索。
 * 后端对「停用最后一个店主」等边界有把守，前端直接提交、报错弹通知。
 */
type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'OWNER' | 'TEACHER';
  isActive: boolean;
  createdAt: string;
};

const ROLE_LABEL: Record<PublicUser['role'], string> = {
  OWNER: '店主',
  TEACHER: '授课老师',
};

export const UsersPage = () => {
  const { tableProps } = useTable<PublicUser>({ resource: 'users' });

  const { mutateAsync: updateAsync } = useUpdate();

  const toggleActive = (record: PublicUser, next: boolean) => {
    const payload = { isActive: next };
    if (next) {
      void updateAsync({ resource: 'users', id: record.id, values: payload });
      return;
    }
    // 停用会影响登录，先确认一次
    Modal.confirm({
      title: `停用账号 ${record.displayName}（${record.username}）？`,
      content: '停用后该账号将无法登录；之后可以再在这里重新启用。',
      okText: '停用',
      okButtonProps: { danger: true },
      onOk: () =>
        updateAsync({
          resource: 'users',
          id: record.id,
          values: payload,
        }),
    });
  };

  return (
    <List title="账号管理">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        只读列表：账号由登录页注册 / 初始化向导创建，这里只做启用和停用；不能删除账号。
      </Typography.Paragraph>
      <Table {...tableProps} rowKey="id">
        <Table.Column dataIndex="username" title="用户名" />
        <Table.Column dataIndex="displayName" title="显示名" />
        <Table.Column
          dataIndex="role"
          title="角色"
          width={110}
          render={(value: PublicUser['role']) => (
            <Tag color={value === 'OWNER' ? 'gold' : 'blue'}>{ROLE_LABEL[value]}</Tag>
          )}
        />
        <Table.Column
          dataIndex="createdAt"
          title="创建时间"
          render={(value: string) => value.slice(0, 10)}
        />
        <Table.Column
          dataIndex="isActive"
          title="启用"
          width={90}
          render={(value: boolean, record: PublicUser) => (
            <Space>
              <Switch checked={value} onChange={(next) => toggleActive(record, next)} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
