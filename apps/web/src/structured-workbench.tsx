import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Input, Select, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { notifyAuthExpired } from './assistant-client.js';

const { Text, Title } = Typography;
const TOKEN_KEY = 'pianomanager.accessToken';

type Section = 'students' | 'schedule' | 'finance';
type Student = { id: string; name: string; notes: string | null; enrollmentStatus: string; createdAt: string; updatedAt: string };
type Teacher = { id: string; name: string; isActive: boolean };
type CourseAccount = { id: string; courseId: string; courseName: string; defaultDurationMinutes: number; currentUnitPrice: string; version: number };
type Lesson = { id: string; accountId: string; teacherId: string; startsAt: string; endsAt: string; status: string; student: { id: string; name: string }; course: { id: string; name: string }; unitPriceSnapshot: string | null };
type Report = { periodStart: string; cashIncome: string; cashExpense: string; cashNet: string; lessonIncome: string; refundFeeIncome: string; manualIncome: string; payrollCost: string; giftCost: string; manualExpense: string; operatingProfit: string };
type Payroll = { id: string; teacherId: string; teacherName: string; periodStart: string; courseRevenue: string; baseSalary: string; commissionRate: string; commissionAmount: string; bonusAmount: string; deductionAmount: string; grossSalary: string; netSalary: string; status: 'UNPAID' | 'PAID'; paidAt: string | null; paymentChannel: string | null; version: number };
type ManualTransaction = { id: string; kind: 'INCOME' | 'EXPENSE'; incomeCategory: string | null; expenseCategory: string | null; amount: string; channel: string; occurredAt: string; note: string | null; createdAt: string };
type ClosedPeriod = { period: string; closedAt: string; reopenedAt: string | null; reopenReason: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new Error('当前浏览器不支持安全的幂等键生成');
}

async function request<T>(path: string, validate: (value: unknown) => value is T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    if (response.status === 401) {
      notifyAuthExpired();
      throw new Error('登录状态已失效，请重新登录后再试。');
    }
    if (response.status === 403) throw new Error('当前账号无权执行此操作。');
    throw new Error(`请求失败（HTTP ${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json();
  if (!validate(payload)) throw new Error('Core API 返回的数据格式无效');
  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> { return isRecord(value); }
function isList<T>(value: unknown, item: (value: unknown) => value is T): value is T[] { return Array.isArray(value) && value.every(item); }
function isStudent(value: unknown): value is Student { return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && (value.notes === null || typeof value.notes === 'string') && typeof value.enrollmentStatus === 'string' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'; }
function isTeacher(value: unknown): value is Teacher { return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.isActive === 'boolean'; }
function isAccount(value: unknown): value is CourseAccount { return isRecord(value) && typeof value.id === 'string' && typeof value.courseId === 'string' && typeof value.courseName === 'string' && typeof value.defaultDurationMinutes === 'number' && typeof value.currentUnitPrice === 'string' && typeof value.version === 'number'; }
function isLesson(value: unknown): value is Lesson { return isRecord(value) && typeof value.id === 'string' && typeof value.accountId === 'string' && typeof value.teacherId === 'string' && typeof value.startsAt === 'string' && typeof value.endsAt === 'string' && typeof value.status === 'string' && isRecord(value.student) && typeof value.student.id === 'string' && typeof value.student.name === 'string' && isRecord(value.course) && typeof value.course.id === 'string' && typeof value.course.name === 'string' && (value.unitPriceSnapshot === null || typeof value.unitPriceSnapshot === 'string'); }
function isReport(value: unknown): value is Report { return isRecord(value) && ['periodStart', 'cashIncome', 'cashExpense', 'cashNet', 'lessonIncome', 'refundFeeIncome', 'manualIncome', 'payrollCost', 'giftCost', 'manualExpense', 'operatingProfit'].every((key) => typeof value[key] === 'string'); }
function isPayroll(value: unknown): value is Payroll { return isRecord(value) && typeof value.id === 'string' && typeof value.teacherId === 'string' && typeof value.teacherName === 'string' && typeof value.periodStart === 'string' && typeof value.courseRevenue === 'string' && typeof value.baseSalary === 'string' && typeof value.commissionRate === 'string' && typeof value.commissionAmount === 'string' && typeof value.bonusAmount === 'string' && typeof value.deductionAmount === 'string' && typeof value.grossSalary === 'string' && typeof value.netSalary === 'string' && (value.status === 'UNPAID' || value.status === 'PAID') && (value.paidAt === null || typeof value.paidAt === 'string') && (value.paymentChannel === null || typeof value.paymentChannel === 'string') && typeof value.version === 'number'; }
function isManualTransaction(value: unknown): value is ManualTransaction { return isRecord(value) && typeof value.id === 'string' && (value.kind === 'INCOME' || value.kind === 'EXPENSE') && (value.incomeCategory === null || typeof value.incomeCategory === 'string') && (value.expenseCategory === null || typeof value.expenseCategory === 'string') && typeof value.amount === 'string' && typeof value.channel === 'string' && typeof value.occurredAt === 'string' && (value.note === null || typeof value.note === 'string') && typeof value.createdAt === 'string'; }
function isClosedPeriod(value: unknown): value is ClosedPeriod { return isRecord(value) && typeof value.period === 'string' && typeof value.closedAt === 'string' && (value.reopenedAt === null || typeof value.reopenedAt === 'string') && (value.reopenReason === null || typeof value.reopenReason === 'string'); }

function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间无效' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
function money(value: string): string { return `¥${value}`; }
function monthNow(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date()); }
function localNow(): string { const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date()); return parts.replace(' ', 'T'); }
function toOffsetDate(value: string): string { return value.length === 16 ? `${value}:00+08:00` : `${value}+08:00`; }
function post(path: string, body: unknown, withIdempotency = false) { const headers = withIdempotency ? { 'Idempotency-Key': idempotencyKey() } : undefined; return request(path, isObject, { method: 'POST', ...(headers ? { headers } : {}), body: JSON.stringify(body) }); }
function patch(path: string, body: unknown) { return request(path, isObject, { method: 'PATCH', body: JSON.stringify(body) }); }

export function StructuredWorkbench({ section }: { section: Section }) {
  if (section === 'students') return <StudentsWorkbench />;
  if (section === 'schedule') return <ScheduleWorkbench />;
  return <FinanceWorkbench />;
}

function WorkbenchHeader({ title, description }: { title: string; description: string }) {
  return <div className="structured-heading"><div><span className="eyebrow accent-eyebrow">CORE API · STRUCTURED FALLBACK</span><Title level={1}>{title}</Title><p className="intro-copy">{description}</p></div><Tag color="gold">AI 不可用也可操作</Tag></div>;
}

function ActionFeedback({ message, onClose }: { message: { type: 'success' | 'error'; text: string } | null; onClose: () => void }) {
  return message ? <Alert closable className="structured-feedback" message={message.text} onClose={onClose} showIcon type={message.type} /> : null;
}

function StudentsWorkbench() {
  const client = useQueryClient();
  const students = useQuery({ queryKey: ['structured-students'], queryFn: () => request('/api/students', (value): value is Student[] => isList(value, isStudent)) });
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<Student | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await post('/api/students', { name, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      setName(''); setNotes(''); setFeedback({ type: 'success', text: '学生已创建' }); await client.invalidateQueries({ queryKey: ['structured-students'] });
    } catch (error) { setFeedback({ type: 'error', text: error instanceof Error ? error.message : '创建学生失败' }); }
  };
  const update = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editing) return;
    try {
      await patch(`/api/students/${editing.id}`, { name: editing.name, notes: editing.notes?.trim() || null });
      setFeedback({ type: 'success', text: '学生资料已更新' }); setEditing(null); await client.invalidateQueries({ queryKey: ['structured-students'] });
    } catch (error) { setFeedback({ type: 'error', text: error instanceof Error ? error.message : '更新学生失败' }); }
  };
  const columns: TableColumnsType<Student> = [
    { title: '学生', dataIndex: 'name' },
    { title: '学籍', dataIndex: 'enrollmentStatus', render: (value: string) => <Tag>{({ STUDYING: '在读', FROZEN: '冻结', WITHDRAWN: '退学' } as Record<string, string>)[value] ?? value}</Tag> },
    { title: '备注', dataIndex: 'notes', render: (value: string | null) => value || '—' },
    { title: '建档时间', dataIndex: 'createdAt', render: (value: string) => formatDate(value) },
    { title: '操作', key: 'action', render: (_value, record) => <Button size="small" onClick={() => setEditing({ ...record })}>编辑</Button> },
  ];
  return <section aria-labelledby="structured-heading" className="structured-view"><WorkbenchHeader title="学生与账户" description="查询并维护 Core API 中的真实学生资料。" /><ActionFeedback message={feedback} onClose={() => setFeedback(null)} />
    <div className="structured-toolbar"><span>学生档案</span><a href="/api/docs" rel="noreferrer" target="_blank">完整业务接口 ↗</a></div>
    <div className="fallback-form-grid"><Card className="data-card" title="新增学生"><form className="structured-form" onSubmit={submit}><label htmlFor="new-student-name">姓名</label><Input id="new-student-name" onChange={(event) => setName(event.target.value)} required value={name} /><label htmlFor="new-student-notes">备注</label><Input.TextArea id="new-student-notes" onChange={(event) => setNotes(event.target.value)} value={notes} /><Button htmlType="submit" type="primary">创建学生</Button></form></Card>{editing && <Card className="data-card" title={`编辑：${editing.name}`}><form className="structured-form" onSubmit={update}><label htmlFor="edit-student-name">姓名</label><Input id="edit-student-name" onChange={(event) => setEditing({ ...editing, name: event.target.value })} required value={editing.name} /><label htmlFor="edit-student-notes">备注</label><Input.TextArea id="edit-student-notes" onChange={(event) => setEditing({ ...editing, notes: event.target.value })} value={editing.notes ?? ''} /><div className="form-actions"><Button htmlType="submit" type="primary">保存修改</Button><Button onClick={() => setEditing(null)}>取消</Button></div></form></Card>}</div>
    <Card className="data-card" title="真实学生列表" loading={students.isLoading}>{students.isError ? <Alert message="暂时无法读取学生" description={students.error.message} type="error" showIcon /> : <Table aria-label="学生列表" columns={columns} dataSource={students.data} locale={{ emptyText: <Empty description="Core API 暂无学生记录" /> }} pagination={{ pageSize: 10 }} rowKey="id" />}</Card>
  </section>;
}

function ScheduleWorkbench() {
  const client = useQueryClient();
  const lessons = useQuery({ queryKey: ['structured-lessons'], queryFn: () => request('/api/lessons', (value): value is Lesson[] => isList(value, isLesson)) });
  const students = useQuery({ queryKey: ['structured-students-for-schedule'], queryFn: () => request('/api/students', (value): value is Student[] => isList(value, isStudent)) });
  const teachers = useQuery({ queryKey: ['structured-teachers'], queryFn: () => request('/api/teachers', (value): value is Teacher[] => isList(value, isTeacher)) });
  const [studentId, setStudentId] = useState(''); const [accountId, setAccountId] = useState(''); const [teacherId, setTeacherId] = useState(''); const [startsAt, setStartsAt] = useState(''); const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null); const [newStartsAt, setNewStartsAt] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const accounts = useQuery({ queryKey: ['structured-accounts', studentId], queryFn: () => request(`/api/students/${studentId}/course-accounts`, (value): value is CourseAccount[] => isList(value, isAccount)), enabled: Boolean(studentId) });
  const action = async (operation: () => Promise<unknown>, success: string) => { try { await operation(); setFeedback({ type: 'success', text: success }); await client.invalidateQueries({ queryKey: ['structured-lessons'] }); } catch (error) { setFeedback({ type: 'error', text: error instanceof Error ? error.message : '排课操作失败' }); } };
  const create = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await action(() => post('/api/lessons', { accountId, teacherId, startsAt: toOffsetDate(startsAt) }), '排课已创建'); setStudentId(''); setAccountId(''); setTeacherId(''); setStartsAt(''); };
  const reschedule = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!selectedLesson || !newStartsAt) return; await action(() => patch(`/api/lessons/${selectedLesson.id}/reschedule`, { startsAt: toOffsetDate(newStartsAt) }), '排课时间已调整'); setSelectedLesson(null); setNewStartsAt(''); };
  const columns: TableColumnsType<Lesson> = [
    { title: '时间', dataIndex: 'startsAt', render: (value: string, record) => <span>{formatDate(value)}<br /><small>至 {formatDate(record.endsAt)}</small></span> },
    { title: '学生', dataIndex: ['student', 'name'] }, { title: '课程', dataIndex: ['course', 'name'] },
    { title: '状态', dataIndex: 'status', render: (value: string) => <Tag>{({ SCHEDULED: '已排课', COMPLETED: '已完成', CANCELLED: '已取消' } as Record<string, string>)[value] ?? value}</Tag> },
    { title: '操作', key: 'action', render: (_value, record) => record.status === 'SCHEDULED' ? <div className="table-actions"><Button size="small" onClick={() => { setSelectedLesson(record); setNewStartsAt(''); }}>调课</Button><Button size="small" onClick={() => void action(() => post(`/api/lessons/${record.id}/cancel`, {}), '排课已取消')}>请假/取消</Button><Button size="small" type="primary" onClick={() => void action(() => post(`/api/lessons/${record.id}/complete`, {}, true), '课程已确认完成')}>确认上课</Button></div> : '—' },
  ];
  return <section aria-labelledby="structured-heading" className="structured-view"><WorkbenchHeader title="排课与课消" description="查询真实排课，直接进行排课、调课、请假取消和上课确认。" /><ActionFeedback message={feedback} onClose={() => setFeedback(null)} />
    <div className="structured-toolbar"><span>排课操作遵守 Core 权限与幂等规则</span><a href="/api/docs" rel="noreferrer" target="_blank">完整业务接口 ↗</a></div>
    <Card className="data-card" title="创建单节排课"><form className="structured-form inline-form"><label htmlFor="schedule-student">学生</label><Select id="schedule-student" onChange={(value) => { setStudentId(value ?? ''); setAccountId(''); }} options={students.data?.map((student) => ({ label: student.name, value: student.id })) ?? []} placeholder="选择学生" value={studentId || null} /><label htmlFor="schedule-account">课程账户</label><Select id="schedule-account" disabled={!studentId || accounts.isLoading} onChange={(value) => setAccountId(value ?? '')} options={accounts.data?.map((account) => ({ label: `${account.courseName}（${account.defaultDurationMinutes} 分钟）`, value: account.id })) ?? []} placeholder="选择课程" value={accountId || null} /><label htmlFor="schedule-teacher">教师</label><Select id="schedule-teacher" onChange={(value) => setTeacherId(value ?? '')} options={teachers.data?.filter((teacher) => teacher.isActive).map((teacher) => ({ label: teacher.name, value: teacher.id })) ?? []} placeholder="选择教师" value={teacherId || null} /><label htmlFor="schedule-time">开始时间</label><Input id="schedule-time" onChange={(event) => setStartsAt(event.target.value)} type="datetime-local" value={startsAt} /><Button disabled={!studentId || !accountId || !teacherId || !startsAt} onClick={(event) => { event.preventDefault(); void create(event as unknown as FormEvent<HTMLFormElement>); }} type="primary">创建排课</Button></form></Card>
    {selectedLesson && <Card className="data-card" title={`调课：${selectedLesson.student.name} · ${selectedLesson.course.name}`}><form className="structured-form inline-form" onSubmit={reschedule}><label htmlFor="reschedule-time">新的开始时间</label><Input id="reschedule-time" onChange={(event) => setNewStartsAt(event.target.value)} required type="datetime-local" value={newStartsAt} /><Button htmlType="submit" type="primary">保存调课</Button><Button onClick={() => setSelectedLesson(null)}>取消</Button></form></Card>}
    <Card className="data-card" title="真实排课列表" loading={lessons.isLoading}>{lessons.isError ? <Alert message="暂时无法读取排课" description={lessons.error.message} type="error" showIcon /> : <Table aria-label="排课列表" columns={columns} dataSource={lessons.data} locale={{ emptyText: <Empty description="Core API 暂无排课记录" /> }} pagination={{ pageSize: 10 }} rowKey="id" />}</Card>
  </section>;
}

const incomeCategories = [{ label: '卖书', value: 'BOOK_SALE' }, { label: '卖琴', value: 'INSTRUMENT_SALE' }, { label: '外部合作', value: 'EXTERNAL_COOPERATION' }, { label: '其他经营收入', value: 'OTHER_INCOME' }];
const expenseCategories = [{ label: '房租物业', value: 'RENT_PROPERTY' }, { label: '水电网络', value: 'UTILITIES_NETWORK' }, { label: '营销', value: 'MARKETING' }, { label: '办公用品', value: 'OFFICE_SUPPLIES' }, { label: '维修', value: 'MAINTENANCE' }, { label: '图书采购成本', value: 'BOOK_PURCHASE_COST' }, { label: '琴类采购成本', value: 'INSTRUMENT_PURCHASE_COST' }, { label: '外部合作成本', value: 'EXTERNAL_COOPERATION_COST' }, { label: '其他支出', value: 'OTHER_EXPENSE' }];
const channels = [{ label: '现金', value: 'CASH' }, { label: '微信', value: 'WECHAT' }, { label: '支付宝', value: 'ALIPAY' }, { label: '银行卡', value: 'BANK_CARD' }, { label: '其他', value: 'OTHER' }];

function FinanceWorkbench() {
  const client = useQueryClient(); const [period, setPeriod] = useState(monthNow); const [tab, setTab] = useState<'report' | 'payroll' | 'manual' | 'periods'>('report'); const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const report = useQuery({ queryKey: ['structured-report', period], queryFn: () => request(`/api/reports/monthly?period=${encodeURIComponent(period)}`, isReport), enabled: /^\d{4}-\d{2}$/.test(period) });
  const payroll = useQuery({ queryKey: ['structured-payroll', period], queryFn: () => request(`/api/payrolls?period=${encodeURIComponent(period)}`, (value): value is Payroll[] => isList(value, isPayroll)), enabled: tab === 'payroll' });
  const manual = useQuery({ queryKey: ['structured-manual', period], queryFn: () => request(`/api/manual-transactions?from=${encodeURIComponent(`${period}-01T00:00:00+08:00`)}&to=${encodeURIComponent(`${nextMonth(period)}-01T00:00:00+08:00`)}`, (value): value is ManualTransaction[] => isList(value, isManualTransaction)), enabled: tab === 'manual' });
  const periods = useQuery({ queryKey: ['structured-periods'], queryFn: () => request('/api/periods', (value): value is ClosedPeriod[] => isList(value, isClosedPeriod)), enabled: tab === 'periods' });
  const teachers = useQuery({ queryKey: ['structured-finance-teachers'], queryFn: () => request('/api/teachers', (value): value is Teacher[] => isList(value, isTeacher)), enabled: tab === 'payroll' });
  const action = async (operation: () => Promise<unknown>, success: string, invalidate: string[]) => { try { await operation(); setFeedback({ type: 'success', text: success }); for (const key of invalidate) await client.invalidateQueries({ queryKey: [key] }); } catch (error) { setFeedback({ type: 'error', text: error instanceof Error ? error.message : '财务操作失败' }); } };
  return <section aria-labelledby="structured-heading" className="structured-view"><WorkbenchHeader title="收支与报表" description="月度经营报表、工资、手工收支和关账均直接连接 Core API。" /><ActionFeedback message={feedback} onClose={() => setFeedback(null)} /><div className="structured-toolbar"><label className="period-control">业务月份<Input aria-label="报表月份" onChange={(event) => setPeriod(event.target.value)} type="month" value={period} /></label><a href="/api/docs" rel="noreferrer" target="_blank">完整业务接口 ↗</a></div><div className="workbench-tabs" role="tablist">{[['report', '月度报表'], ['payroll', '工资'], ['manual', '手工收支'], ['periods', '关账']].map(([value, label]) => <button aria-selected={tab === value} className={tab === value ? 'is-active' : ''} key={value} onClick={() => setTab(value as typeof tab)} role="tab" type="button">{label}</button>)}</div>{tab === 'report' && <ReportPanel report={report.data} loading={report.isLoading} error={report.error} />}{tab === 'payroll' && <PayrollPanel period={period} payroll={payroll.data} teachers={teachers.data} loading={payroll.isLoading} onAction={action} />}{tab === 'manual' && <ManualPanel period={period} transactions={manual.data} loading={manual.isLoading} onAction={action} />}{tab === 'periods' && <PeriodsPanel periods={periods.data} loading={periods.isLoading} onAction={action} />}</section>;
}

function ReportPanel({ report, loading, error }: { report: Report | undefined; loading: boolean; error: Error | null }) { const items = report ? [['现金收入', report.cashIncome], ['现金支出', report.cashExpense], ['现金净额', report.cashNet], ['课消收入', report.lessonIncome], ['退费手续费收入', report.refundFeeIncome], ['其他收入', report.manualIncome], ['工资成本', report.payrollCost], ['赠送成本', report.giftCost], ['其他支出', report.manualExpense], ['经营利润', report.operatingProfit]] : []; return <>{loading && <Card className="data-card"><div className="loading-state" role="status">正在读取月报…</div></Card>}{error && <Alert message="暂时无法读取月报" description={error.message} type="error" showIcon />}{report && <div aria-label="月度财务报表" className="report-grid">{items.map(([label, value]) => <Card className="report-card" key={label} variant="borderless"><Text>{label}</Text><Title level={3}>{money(value ?? '')}</Title></Card>)}</div>}</>; }

function PayrollPanel({ period, payroll, teachers, loading, onAction }: { period: string; payroll: Payroll[] | undefined; teachers: Teacher[] | undefined; loading: boolean; onAction: (operation: () => Promise<unknown>, success: string, invalidate: string[]) => Promise<void> }) { const [teacherId, setTeacherId] = useState(''); const [selected, setSelected] = useState<Payroll | null>(null); const [paidAt, setPaidAt] = useState(localNow); const [channel, setChannel] = useState('CASH'); return <div className="finance-panel"><Card className="data-card" title="生成工资"><form className="structured-form inline-form" onSubmit={(event) => { event.preventDefault(); if (teacherId) void onAction(() => post('/api/payrolls', { teacherId, period }), '工资已生成', ['structured-payroll']); }}><Select aria-label="工资教师" onChange={(value) => setTeacherId(value ?? '')} options={teachers?.filter((teacher) => teacher.isActive).map((teacher) => ({ label: teacher.name, value: teacher.id })) ?? []} placeholder="选择教师" value={teacherId || null} /><Button disabled={!teacherId} htmlType="submit" type="primary">生成本月工资</Button></form></Card><Card className="data-card" title="工资单" loading={loading}>{payroll && <Table<Payroll> aria-label="工资列表" columns={[{ title: '教师', dataIndex: 'teacherName' }, { title: '课消收入', dataIndex: 'courseRevenue', render: money }, { title: '实发', dataIndex: 'netSalary', render: money }, { title: '状态', dataIndex: 'status', render: (value) => <Tag>{value === 'PAID' ? '已支付' : '未支付'}</Tag> }, { title: '操作', render: (_value, record) => record.status === 'UNPAID' ? <Button size="small" onClick={() => setSelected(record)}>登记支付</Button> : '—' }]} dataSource={payroll} rowKey="id" locale={{ emptyText: <Empty description="本月暂无工资记录" /> }} pagination={{ pageSize: 10 }} />}</Card>{selected && <Card className="data-card" title={`登记工资支付：${selected.teacherName}`}><form className="structured-form inline-form" onSubmit={(event) => { event.preventDefault(); void onAction(() => post(`/api/payrolls/${selected.id}/pay`, { paidAt: toOffsetDate(paidAt), channel }), '工资支付已登记', ['structured-payroll', 'structured-report']); setSelected(null); }}><Input aria-label="工资支付时间" onChange={(event) => setPaidAt(event.target.value)} type="datetime-local" value={paidAt} /><Select aria-label="工资支付渠道" onChange={(value) => setChannel(value ?? 'CASH')} options={channels} value={channel} /><Button htmlType="submit" type="primary">确认支付登记</Button><Button onClick={() => setSelected(null)}>取消</Button></form></Card>}</div>; }

function ManualPanel({ period, transactions, loading, onAction }: { period: string; transactions: ManualTransaction[] | undefined; loading: boolean; onAction: (operation: () => Promise<unknown>, success: string, invalidate: string[]) => Promise<void> }) { const [kind, setKind] = useState<'INCOME' | 'EXPENSE'>('INCOME'); const [category, setCategory] = useState('BOOK_SALE'); const [amount, setAmount] = useState('0.00'); const [channel, setChannel] = useState('CASH'); const [occurredAt, setOccurredAt] = useState(localNow); const [note, setNote] = useState(''); const categories = kind === 'INCOME' ? incomeCategories : expenseCategories; return <div className="finance-panel"><Card className="data-card" title="登记手工收支"><form className="structured-form inline-form" onSubmit={(event) => { event.preventDefault(); const body = { kind, amount, channel, occurredAt: toOffsetDate(occurredAt), ...(kind === 'INCOME' ? { incomeCategory: category } : { expenseCategory: category }), ...(note.trim() ? { note: note.trim() } : {}) }; void onAction(() => post('/api/manual-transactions', body), '手工收支已登记', ['structured-manual', 'structured-report']); }}><Select aria-label="收支类型" onChange={(value: 'INCOME' | 'EXPENSE') => { setKind(value); setCategory(value === 'INCOME' ? 'BOOK_SALE' : 'RENT_PROPERTY'); }} options={[{ label: '收入', value: 'INCOME' }, { label: '支出', value: 'EXPENSE' }]} value={kind} /><Select aria-label="收支分类" onChange={(value) => setCategory(value ?? 'BOOK_SALE')} options={categories} value={category} /><Input aria-label="金额" onChange={(event) => setAmount(event.target.value)} placeholder="100.00" value={amount} /><Select aria-label="收支渠道" onChange={(value) => setChannel(value ?? 'CASH')} options={channels} value={channel} /><Input aria-label="发生时间" onChange={(event) => setOccurredAt(event.target.value)} type="datetime-local" value={occurredAt} /><Input aria-label="备注" onChange={(event) => setNote(event.target.value)} placeholder="可选备注" value={note} /><Button htmlType="submit" type="primary">登记收支</Button></form></Card><Card className="data-card" title={`${period} 手工收支`} loading={loading}>{transactions && <Table<ManualTransaction> aria-label="手工收支列表" columns={[{ title: '发生时间', dataIndex: 'occurredAt', render: formatDate }, { title: '类型', dataIndex: 'kind', render: (value) => value === 'INCOME' ? '收入' : '支出' }, { title: '分类', render: (_value, record) => record.incomeCategory ?? record.expenseCategory ?? '—' }, { title: '金额', dataIndex: 'amount', render: money }, { title: '渠道', dataIndex: 'channel' }, { title: '备注', dataIndex: 'note', render: (value) => value || '—' }]} dataSource={transactions} rowKey="id" locale={{ emptyText: '本月暂无手工收支' }} pagination={{ pageSize: 10 }} />}</Card></div>; }

function PeriodsPanel({ periods, loading, onAction }: { periods: ClosedPeriod[] | undefined; loading: boolean; onAction: (operation: () => Promise<unknown>, success: string, invalidate: string[]) => Promise<void> }) { const [closePeriod, setClosePeriod] = useState(monthNow); const [reopen, setReopen] = useState<ClosedPeriod | null>(null); const [reason, setReason] = useState(''); return <div className="finance-panel"><Card className="data-card" title="月度关账"><form className="structured-form inline-form" onSubmit={(event) => { event.preventDefault(); void onAction(() => post('/api/periods/close', { period: closePeriod }), '月份已关账', ['structured-periods']); }}><Input aria-label="关账月份" onChange={(event) => setClosePeriod(event.target.value)} type="month" value={closePeriod} /><Button htmlType="submit" type="primary">关账</Button></form><Text className="form-help">关账会阻止该业务月份的资金、课消等历史写入。</Text></Card><Card className="data-card" title="已关账月份" loading={loading}>{periods && <Table<ClosedPeriod> aria-label="关账列表" columns={[{ title: '月份', dataIndex: 'period' }, { title: '关账时间', dataIndex: 'closedAt', render: formatDate }, { title: '状态', render: (_value, record) => <Tag>{record.reopenedAt ? '已重新打开' : '已关账'}</Tag> }, { title: '操作', render: (_value, record) => !record.reopenedAt ? <Button size="small" onClick={() => setReopen(record)}>重新打开</Button> : '—' }]} dataSource={periods} rowKey="period" locale={{ emptyText: <Empty description="暂无关账记录" /> }} pagination={{ pageSize: 10 }} />}</Card>{reopen && <Card className="data-card" title={`重新打开 ${reopen.period}`}><form className="structured-form inline-form" onSubmit={(event) => { event.preventDefault(); void onAction(() => post('/api/periods/reopen', { period: reopen.period, reason }), '月份已重新打开', ['structured-periods']); setReopen(null); setReason(''); }}><Input aria-label="重新打开原因" onChange={(event) => setReason(event.target.value)} placeholder="填写原因" required value={reason} /><Button htmlType="submit" type="primary">确认重新打开</Button><Button onClick={() => setReopen(null)}>取消</Button></form></Card>}</div>; }

function nextMonth(period: string): string { const [yearText = '0', monthText = '0'] = period.split('-'); const date = new Date(Date.UTC(Number(yearText), Number(monthText), 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
