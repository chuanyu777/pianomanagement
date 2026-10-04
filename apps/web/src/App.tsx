import React from 'react';
import { Authenticated, Refine } from '@refinedev/core';
import { RefineKbarProvider, RefineKbar } from '@refinedev/kbar';
import { useNotificationProvider, ThemedLayout, ErrorComponent } from '@refinedev/antd';
import routerProvider, {
  CatchAllNavigate,
  NavigateToResource,
  UnsavedChangesNotifier,
  DocumentTitleHandler,
} from '@refinedev/react-router';
import { BrowserRouter, Routes, Route, Outlet } from 'react-router';
import {
  DashboardOutlined,
  TagsOutlined,
  TeamOutlined,
  UserOutlined,
  UnorderedListOutlined,
  ProfileOutlined,
  CalendarOutlined,
  AccountBookOutlined,
  PayCircleOutlined,
  BarChartOutlined,
  AlertOutlined,
  SettingOutlined,
  DollarOutlined,

} from '@ant-design/icons';

import '@ant-design/v5-patch-for-react-19';
import '@refinedev/antd/dist/reset.css';

import { dataProvider } from './data-provider';
import { authProvider } from './auth-provider';

import { DashboardPage } from './pages/dashboard/page';
import { LoginPage } from './pages/login/page';
import { BootstrapPage } from './pages/bootstrap/page';
import { CourseTypesList } from './pages/course-types/list';
import { TeachersPage } from './pages/teachers/page';
import { StudentsPage } from './pages/students/page';
import { EnrollmentsPage } from './pages/enrollments/page';
import { UsersPage } from './pages/users/page';
import { ItemsPage } from './pages/items/page';
import { LessonsPage } from './pages/lessons/page';
import { LedgerPage } from './pages/ledger/page';
import { FinancePage } from './pages/finance/page';
import { PayrollPage } from './pages/payroll/page';
import { AnalyticsPage } from './pages/analytics/page';
import { RisksPage } from './pages/risks/page';
import { OnboardingPage } from './pages/onboarding/page';

/**
 * 资源清单一次性把路由和左侧菜单都接好。
 * 页面组件在 src/pages/<模块>/ 下，菜单名用 meta.label（中文）。
 *
 * 分工约定：**路由只在这里改一次**，各页面只改自己的文件 ——
 * 否则并行开发时大家都在抢 App.tsx。
 */
const App: React.FC = () => {
  return (
    <BrowserRouter>
      <RefineKbarProvider>
        <Refine
          routerProvider={routerProvider}
          dataProvider={dataProvider}
          authProvider={authProvider}
          notificationProvider={useNotificationProvider}
          options={{
            syncWithLocation: true,
            warnWhenUnsavedChanges: true,
            disableTelemetry: true,
          }}
          resources={[
            { name: 'dashboard', list: '/', meta: { label: '经营总览', icon: <DashboardOutlined /> } },
            { name: 'lessons', list: '/lessons', meta: { label: '排课与上课', icon: <CalendarOutlined /> } },
            { name: 'ledger', list: '/ledger', meta: { label: '学生台账', icon: <AccountBookOutlined /> } },
            { name: 'students', list: '/students', meta: { label: '学生档案', icon: <UserOutlined /> } },
            { name: 'enrollments', list: '/enrollments', meta: { label: '报名与单价', icon: <ProfileOutlined /> } },
            { name: 'course-types', list: '/course-types', meta: { label: '课程类型', icon: <TagsOutlined /> } },
            { name: 'teachers', list: '/teachers', meta: { label: '老师档案', icon: <TeamOutlined /> } },
            { name: 'finance', list: '/finance', meta: { label: '收支管理', icon: <DollarOutlined /> } },
            { name: 'payroll', list: '/payroll', meta: { label: '工资表', icon: <PayCircleOutlined /> } },
            { name: 'items', list: '/items', meta: { label: '收支项目', icon: <UnorderedListOutlined /> } },
            { name: 'analytics', list: '/analytics', meta: { label: '经营分析', icon: <BarChartOutlined /> } },
            { name: 'risks', list: '/risks', meta: { label: '风险提醒', icon: <AlertOutlined /> } },
            { name: 'users', list: '/users', meta: { label: '账号管理', icon: <UserOutlined /> } },
            { name: 'onboarding', list: '/onboarding', meta: { label: '初始化向导', icon: <SettingOutlined /> } },
          ]}
        >
          <Routes>
            {/* 业务页面：必须登录 */}
            <Route
              element={
                <Authenticated key="app" fallback={<CatchAllNavigate to="/login" />}>
                  <ThemedLayout>
                    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 16px' }}>
                      <Outlet />
                    </div>
                  </ThemedLayout>
                </Authenticated>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="/lessons" element={<LessonsPage />} />
              <Route path="/ledger" element={<LedgerPage />} />
              <Route path="/students" element={<StudentsPage />} />
              <Route path="/enrollments" element={<EnrollmentsPage />} />
              <Route path="/course-types" element={<CourseTypesList />} />
              <Route path="/teachers" element={<TeachersPage />} />
              <Route path="/finance" element={<FinancePage />} />
              <Route path="/payroll" element={<PayrollPage />} />
              <Route path="/items" element={<ItemsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/risks" element={<RisksPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
            </Route>

            {/* 登录 / 首次引导：已登录则回首页 */}
            <Route
              element={
                <Authenticated key="auth-pages" fallback={<Outlet />}>
                  <NavigateToResource resource="dashboard" />
                </Authenticated>
              }
            >
              <Route path="/login" element={<LoginPage />} />
              <Route path="/bootstrap" element={<BootstrapPage />} />
            </Route>

            <Route
              element={
                <Authenticated key="catch-all">
                  <ThemedLayout>
                    <Outlet />
                  </ThemedLayout>
                </Authenticated>
              }
            >
              <Route path="*" element={<ErrorComponent />} />
            </Route>
          </Routes>
          <UnsavedChangesNotifier />
          <DocumentTitleHandler />
          <RefineKbar />
        </Refine>
      </RefineKbarProvider>
    </BrowserRouter>
  );
};

export default App;
