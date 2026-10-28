import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Input, Modal, Table, Tabs, Tag, Typography } from 'antd';
import type { components } from '@piano/generated-core-client/generated/core-api';
import { confirmAssistantPreview, createAssistantPreview, getAssistantPreview, notifyAuthExpired, type AssistantPreviewDraft } from './assistant-client.js';
import { PreviewFacts } from './preview-facts.js';

const { Title } = Typography;
const TOKEN_KEY = 'pianomanager.accessToken';
type Teacher = components['schemas']['TeacherResponse'];
type TeacherLoginAccountRequest = components['schemas']['OpenTeacherLoginAccountBody'];
type Course = components['schemas']['CourseResponse'];
type Feedback = { type: 'success' | 'error'; text: string };
type BasicPreview = AssistantPreviewDraft & { success: string };
type AccountEditor = { teacher: Teacher; username: string; password: string; passwordConfirmation: string };
type Editor =
  | { kind: 'teacher-create'; name: string; baseSalary: string; commissionRate: string }
  | { kind: 'teacher-edit'; teacher: Teacher; baseSalary: string; commissionRate: string }
  | { kind: 'course-create'; name: string; defaultUnitPrice: string; defaultDurationMinutes: string }
  | { kind: 'course-edit'; course: Course; name: string; defaultUnitPrice: string; defaultDurationMinutes: string; isActive: boolean };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isTeacher(value: unknown): value is Teacher { return isRecord(value) && typeof value.id === 'string' && (value.userId === null || typeof value.userId === 'string') && (value.username === null || typeof value.username === 'string') && typeof value.name === 'string' && typeof value.isActive === 'boolean' && typeof value.defaultBaseSalary === 'string' && typeof value.defaultCommissionRate === 'string'; }
function isCourse(value: unknown): value is Course { return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.defaultUnitPrice === 'string' && typeof value.defaultDurationMinutes === 'number' && typeof value.isActive === 'boolean'; }
function token(): string | null { return window.localStorage.getItem(TOKEN_KEY); }
function requestIds() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw new Error('当前浏览器不支持安全的幂等键生成');
  return { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() };
}
async function readList<T>(path: string, validate: (value: unknown) => value is T): Promise<T[]> {
  const headers = new Headers({ Accept: 'application/json' });
  const accessToken = token();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(path, { headers });
  if (response.status === 401) { notifyAuthExpired(); throw new Error('登录状态已失效，请重新登录后再试。'); }
  if (!response.ok) throw new Error(response.status === 403 ? '当前账号无权读取基础资料。' : `读取失败（HTTP ${response.status}）`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(validate)) throw new Error('Core 返回的基础资料格式无效');
  return payload;
}
function confirmationKey(previewId: string): string {
  const storageKey = `pianomanager.preview.idempotency.v1:${previewId}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw new Error('当前浏览器不支持安全的幂等键生成');
  const key = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, key);
  return key;
}

export function BasicDataWorkbench() {
  const client = useQueryClient();
  const teachers = useQuery({ queryKey: ['basic-data-teachers'], queryFn: () => readList('/api/teachers', isTeacher) });
  const courses = useQuery({ queryKey: ['basic-data-courses'], queryFn: () => readList('/api/courses', isCourse) });
  const [tab, setTab] = useState('teachers');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<BasicPreview | null>(null);
  const [previewState, setPreviewState] = useState<'checking' | 'pending' | 'confirming' | 'unknown' | 'executed'>('checking');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [previewMessage, setPreviewMessage] = useState('');
  const [accountEditor, setAccountEditor] = useState<AccountEditor | null>(null);
  const [accountConfirmationOpen, setAccountConfirmationOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const confirmingRef = useRef(false);

  const openPreview = async (actionType: string, command: Record<string, unknown>, success: string) => {
    try {
      const result = await createAssistantPreview({ token: token(), path: 'structured-action', body: { actionType, command, ...requestIds() } });
      setPreview({ ...result, success });
      setPreviewState('checking');
      setReceipt(null);
      setPreviewMessage('');
      setEditor(null);
      void getAssistantPreview({ token: token(), previewId: result.previewId }).then((current) => {
        if (current.actionType !== result.actionType || current.schemaVersion !== `${current.actionType}.v1`) {
          setPreviewState('unknown'); setPreviewMessage('确认单版本或类型不受支持，请重新生成。');
        } else if (current.status === 'PENDING') setPreviewState('pending');
        else if (current.status === 'EXECUTED') { setReceipt(current.receipt); setPreviewState('executed'); setPreviewMessage('操作已完成。'); }
        else { setPreviewState('unknown'); setPreviewMessage(`预览当前状态为 ${current.status}，请重新生成确认单。`); }
      }).catch((error: unknown) => { setPreviewState('unknown'); setPreviewMessage(error instanceof Error ? error.message : '无法读取预览状态'); });
    } catch (error) { setFeedback({ type: 'error', text: error instanceof Error ? error.message : '无法创建操作预览' }); }
  };

  const submitEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    if (editor.kind === 'teacher-create') {
      if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(editor.baseSalary) || !/^(?:0|[1-9]\d{0,2})\.\d{4}$/.test(editor.commissionRate)) { setFeedback({ type: 'error', text: '基本工资需为两位小数，提成比例需为四位小数。' }); return; }
      void openPreview('teacher.create', { name: editor.name.trim(), baseSalary: editor.baseSalary, commissionRate: editor.commissionRate }, '教师资料已创建');
    } else if (editor.kind === 'teacher-edit') {
      if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(editor.baseSalary) || !/^(?:0|[1-9]\d{0,2})\.\d{4}$/.test(editor.commissionRate)) { setFeedback({ type: 'error', text: '基本工资需为两位小数，提成比例需为四位小数。' }); return; }
      void openPreview('teacher.compensation.update', { teacherId: editor.teacher.id, baseSalary: editor.baseSalary, commissionRate: editor.commissionRate }, '教师默认薪酬已更新');
    } else if (editor.kind === 'course-create') {
      if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(editor.defaultUnitPrice) || !Number.isInteger(Number(editor.defaultDurationMinutes)) || Number(editor.defaultDurationMinutes) < 1 || Number(editor.defaultDurationMinutes) > 480) { setFeedback({ type: 'error', text: '课程单价需为两位小数，课时需为 1 至 480 分钟。' }); return; }
      void openPreview('course.create', { name: editor.name.trim(), defaultUnitPrice: editor.defaultUnitPrice, defaultDurationMinutes: Number(editor.defaultDurationMinutes) }, '课程已创建');
    } else {
      if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(editor.defaultUnitPrice) || !Number.isInteger(Number(editor.defaultDurationMinutes)) || Number(editor.defaultDurationMinutes) < 1 || Number(editor.defaultDurationMinutes) > 480) { setFeedback({ type: 'error', text: '课程单价需为两位小数，课时需为 1 至 480 分钟。' }); return; }
      void openPreview('course.update', {
        courseId: editor.course.id,
        ...(editor.name !== editor.course.name ? { name: editor.name.trim() } : {}),
        ...(editor.defaultUnitPrice !== editor.course.defaultUnitPrice ? { defaultUnitPrice: editor.defaultUnitPrice } : {}),
        ...(Number(editor.defaultDurationMinutes) !== editor.course.defaultDurationMinutes ? { defaultDurationMinutes: Number(editor.defaultDurationMinutes) } : {}),
        ...(editor.isActive !== editor.course.isActive ? { isActive: editor.isActive } : {}),
      }, '课程资料已更新');
    }
  };

  const confirm = async () => {
    if (!preview || previewState !== 'pending' || confirmingRef.current) return;
    confirmingRef.current = true;
    setPreviewState('confirming'); setPreviewMessage('');
    try {
      const result = await confirmAssistantPreview({ token: token(), previewId: preview.previewId, idempotencyKey: confirmationKey(preview.previewId) });
      setReceipt(result.receipt); setPreviewState('executed'); setPreviewMessage('操作已完成。');
      setFeedback({ type: 'success', text: preview.success });
      await Promise.all([client.invalidateQueries({ queryKey: ['basic-data-teachers'] }), client.invalidateQueries({ queryKey: ['basic-data-courses'] })]);
    } catch (error) {
      setPreviewState('unknown'); setPreviewMessage(error instanceof Error ? error.message : '确认结果未知，请重查 Core 状态。');
    } finally { confirmingRef.current = false; }
  };
  const submitAccountForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accountEditor) return;
    if (accountEditor.password.length < 12 || accountEditor.password.length > 128) {
      setFeedback({ type: 'error', text: '初始密码需为 12 至 128 个字符。' }); return;
    }
    if (accountEditor.password !== accountEditor.passwordConfirmation) {
      setFeedback({ type: 'error', text: '两次输入的初始密码不一致。' }); return;
    }
    if (!accountEditor.username.trim() || accountEditor.username.trim().length > 80) {
      setFeedback({ type: 'error', text: '用户名需为 1 至 80 个字符。' }); return;
    }
    setAccountConfirmationOpen(true);
  };
  const confirmOpenAccount = async () => {
    if (!accountEditor || accountBusy) return;
    setAccountBusy(true);
    let responseStatus: number | undefined;
    try {
      const accessToken = token();
      const body: TeacherLoginAccountRequest = { username: accountEditor.username.trim(), password: accountEditor.password };
      const response = await fetch(`/api/teachers/${encodeURIComponent(accountEditor.teacher.id)}/login-account`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(body),
      });
      responseStatus = response.status;
      if (response.status === 401) {
        notifyAuthExpired();
        setFeedback({ type: 'error', text: '登录状态已失效，请重新登录后查看教师账号状态。' });
        setAccountConfirmationOpen(false);
        setAccountEditor(null);
        return;
      }
      if (response.status === 403) {
        setFeedback({ type: 'error', text: '当前账号无权开通教师登录账号。' });
        setAccountConfirmationOpen(false);
        setAccountEditor(null);
        return;
      }
      if (!response.ok) throw new Error('教师账号开通请求未能确认。');
      const result: unknown = await response.json();
      if (!isTeacher(result)) throw new Error('教师账号开通结果需要重新确认。');
      setFeedback({ type: 'success', text: `已为${result.name}开通登录账号：${result.username}` });
      setAccountConfirmationOpen(false);
      setAccountEditor(null);
      await client.invalidateQueries({ queryKey: ['basic-data-teachers'] });
    } catch {
      try {
        const currentTeachers = await readList('/api/teachers', isTeacher);
        const currentTeacher = currentTeachers.find(({ id }) => id === accountEditor.teacher.id);
        if (currentTeacher?.userId && currentTeacher.username) {
          setFeedback({ type: 'success', text: `当前账号状态：该教师已绑定登录账号 ${currentTeacher.username}` });
        } else if (currentTeacher) {
          setFeedback({
            type: 'error',
            text: responseStatus === 409
              ? '已重新确认：该教师尚未绑定登录账号。请检查用户名是否已被占用，再决定是否重新开通。'
              : '当前教师仍未绑定登录账号；系统没有自动重复提交。确认状态后可再次发起开通。',
          });
        } else {
          setFeedback({ type: 'error', text: '暂时无法确认该教师的账号状态，请刷新教师列表后再操作。' });
        }
      } catch {
        setFeedback({ type: 'error', text: '开通结果暂时无法确认。请刷新教师列表检查账号状态后再操作。' });
      }
      setAccountConfirmationOpen(false);
      setAccountEditor(null);
      await client.invalidateQueries({ queryKey: ['basic-data-teachers'] });
    } finally { setAccountBusy(false); }
  };
  const recheck = async () => {
    if (!preview) return;
    try {
      const current = await getAssistantPreview({ token: token(), previewId: preview.previewId });
      if (current.actionType !== preview.actionType || current.schemaVersion !== preview.schemaVersion || current.schemaVersion !== `${current.actionType}.v1`) {
        setPreviewState('unknown'); setPreviewMessage('确认单版本或类型不受支持，请重新生成。');
      } else if (current.status === 'EXECUTED') {
        setReceipt(current.receipt); setPreviewState('executed'); setPreviewMessage('操作已完成。');
        setFeedback({ type: 'success', text: preview.success });
        await Promise.all([client.invalidateQueries({ queryKey: ['basic-data-teachers'] }), client.invalidateQueries({ queryKey: ['basic-data-courses'] })]);
      } else if (current.status === 'PENDING') { setPreviewState('unknown'); setPreviewMessage('确认结果仍未知，当前只能继续重查状态。'); }
      else { setPreviewState('unknown'); setPreviewMessage(`预览当前状态为 ${current.status}，请重新生成确认单。`); }
    } catch (error) { setPreviewState('unknown'); setPreviewMessage(error instanceof Error ? error.message : '无法读取当前状态'); }
  };

  const teacherColumns = [
    { title: '教师姓名', dataIndex: 'name', key: 'name' },
    { title: '状态', dataIndex: 'isActive', key: 'status', render: (active: boolean) => <Tag>{active ? '在职' : '停用'}</Tag> },
    { title: '默认基本工资', dataIndex: 'defaultBaseSalary', key: 'salary', render: (value: string) => `¥${value}` },
    { title: '默认提成比例', dataIndex: 'defaultCommissionRate', key: 'commission', render: (value: string) => `${value}%` },
    { title: '登录账号', key: 'account', render: (_: unknown, record: Teacher) => record.username ? <Tag color="green">{record.username}</Tag> : <Button onClick={() => { setFeedback(null); setAccountEditor({ teacher: record, username: '', password: '', passwordConfirmation: '' }); }}>开通登录账号</Button> },
    { title: '操作', key: 'actions', render: (_: unknown, record: Teacher) => <Button onClick={() => setEditor({ kind: 'teacher-edit', teacher: record, baseSalary: record.defaultBaseSalary, commissionRate: record.defaultCommissionRate })}>修改薪酬</Button> },
  ];
  const courseColumns = [
    { title: '课程名称', dataIndex: 'name', key: 'name' },
    { title: '状态', dataIndex: 'isActive', key: 'status', render: (active: boolean) => <Tag>{active ? '启用' : '停用'}</Tag> },
    { title: '默认单价', dataIndex: 'defaultUnitPrice', key: 'price', render: (value: string) => `¥${value}` },
    { title: '默认课时', dataIndex: 'defaultDurationMinutes', key: 'duration', render: (value: number) => `${value} 分钟` },
    { title: '操作', key: 'actions', render: (_: unknown, record: Course) => <Button onClick={() => setEditor({ kind: 'course-edit', course: record, name: record.name, defaultUnitPrice: record.defaultUnitPrice, defaultDurationMinutes: String(record.defaultDurationMinutes), isActive: record.isActive })}>编辑课程</Button> },
  ];
  const isTeacherEditor = editor?.kind.startsWith('teacher-') ?? false;
  const isEditing = editor?.kind.endsWith('-edit') ?? false;

  return <section aria-labelledby="basic-data-title" className="structured-view basic-data-workbench">
    <div className="workspace-page-head"><div><span className="eyebrow accent-eyebrow">OPERATING DESK</span><Title id="basic-data-title" level={1}>教师与课程</Title><p className="intro-copy">维护教师资料、默认薪酬和课程信息。变更确认后生效。</p></div></div>
    {feedback && <Alert closable message={feedback.text} onClose={() => setFeedback(null)} showIcon type={feedback.type} />}
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'teachers', label: '教师管理', children: <Card className="data-card" title="教师资料" extra={<Button type="primary" onClick={() => setEditor({ kind: 'teacher-create', name: '', baseSalary: '0.00', commissionRate: '0.0000' })}>新增教师</Button>} loading={teachers.isLoading}>{teachers.error && <Alert message={teachers.error.message} type="error" />}{teachers.data && <Table<Teacher> aria-label="教师列表" columns={teacherColumns} dataSource={teachers.data} rowKey="id" locale={{ emptyText: <Empty description="暂无教师资料" /> }} pagination={{ pageSize: 10 }} />}</Card> },
      { key: 'courses', label: '课程管理', children: <Card className="data-card" title="课程资料" extra={<Button type="primary" onClick={() => setEditor({ kind: 'course-create', name: '', defaultUnitPrice: '0.00', defaultDurationMinutes: '45' })}>新增课程</Button>} loading={courses.isLoading}>{courses.error && <Alert message={courses.error.message} type="error" />}{courses.data && <Table<Course> aria-label="课程列表" columns={courseColumns} dataSource={courses.data} rowKey="id" locale={{ emptyText: <Empty description="暂无课程资料" /> }} pagination={{ pageSize: 10 }} />}</Card> },
    ]} />

    <Modal open={Boolean(editor)} title={`${isEditing ? '编辑' : '新增'}${isTeacherEditor ? '教师资料' : '课程资料'}`} footer={null} onCancel={() => setEditor(null)}>
      {editor && <form className="structured-form" onSubmit={submitEditor}>
        {feedback?.type === 'error' && <Alert message={feedback.text} type="error" showIcon />}
        {(editor.kind === 'teacher-create' || editor.kind === 'teacher-edit') && <>{editor.kind === 'teacher-create' ? <><label htmlFor="teacher-name">教师姓名</label><Input id="teacher-name" aria-label="教师姓名" maxLength={120} onChange={(event) => setEditor((current) => current?.kind === 'teacher-create' ? { ...current, name: event.target.value } : current)} required value={editor.name} /></> : <p>教师：{editor.teacher.name}</p>}
          <label htmlFor="teacher-base-salary">默认基本工资</label><Input id="teacher-base-salary" aria-label="默认基本工资" inputMode="decimal" onChange={(event) => setEditor((current) => current?.kind === 'teacher-create' || current?.kind === 'teacher-edit' ? { ...current, baseSalary: event.target.value } : current)} required value={editor.kind === 'teacher-create' || editor.kind === 'teacher-edit' ? editor.baseSalary : ''} />
          <label htmlFor="teacher-commission">默认提成比例</label><Input id="teacher-commission" aria-label="默认提成比例" inputMode="decimal" onChange={(event) => setEditor((current) => current?.kind === 'teacher-create' || current?.kind === 'teacher-edit' ? { ...current, commissionRate: event.target.value } : current)} required value={editor.kind === 'teacher-create' || editor.kind === 'teacher-edit' ? editor.commissionRate : ''} /></>}
        {(editor.kind === 'course-create' || editor.kind === 'course-edit') && <><label htmlFor="course-name">课程名称</label><Input id="course-name" aria-label="课程名称" maxLength={120} onChange={(event) => setEditor((current) => current && current.kind.startsWith('course-') ? { ...current, name: event.target.value } : current)} required value={editor.name} />
          <label htmlFor="course-price">课程默认单价</label><Input id="course-price" aria-label="课程默认单价" inputMode="decimal" onChange={(event) => setEditor((current) => current && current.kind.startsWith('course-') ? { ...current, defaultUnitPrice: event.target.value } : current)} required value={editor.kind === 'course-create' || editor.kind === 'course-edit' ? editor.defaultUnitPrice : ''} />
          <label htmlFor="course-duration">默认课时（分钟）</label><Input id="course-duration" aria-label="默认课时（分钟）" max={480} min={1} onChange={(event) => setEditor((current) => current && current.kind.startsWith('course-') ? { ...current, defaultDurationMinutes: event.target.value } : current)} required type="number" value={editor.kind === 'course-create' || editor.kind === 'course-edit' ? editor.defaultDurationMinutes : ''} />
          {editor.kind === 'course-edit' && <label><input checked={editor.isActive} onChange={(event) => setEditor((current) => current?.kind === 'course-edit' ? { ...current, isActive: event.target.checked } : current)} type="checkbox" /> 启用课程</label>}</>}
        <Button htmlType="submit" type="primary">生成确认单</Button>
      </form>}
    </Modal>
    <Modal open={Boolean(accountEditor)} title="开通教师登录账号" footer={null} onCancel={() => setAccountEditor(null)} destroyOnHidden>
      {accountEditor && <form className="structured-form" onSubmit={submitAccountForm}>
        <p>为「{accountEditor.teacher.name}」设置登录用户名和初始密码。密码将加密保存且不会显示，请妥善告知教师。</p>
        <label htmlFor="teacher-account-username">登录用户名</label><Input id="teacher-account-username" autoComplete="off" maxLength={80} onChange={(event) => setAccountEditor((current) => current ? { ...current, username: event.target.value } : current)} required value={accountEditor.username} />
        <label htmlFor="teacher-account-password">初始密码（12 至 128 个字符）</label><Input.Password id="teacher-account-password" autoComplete="new-password" maxLength={128} onChange={(event) => setAccountEditor((current) => current ? { ...current, password: event.target.value } : current)} required value={accountEditor.password} />
        <label htmlFor="teacher-account-password-confirm">再次输入初始密码</label><Input.Password id="teacher-account-password-confirm" autoComplete="new-password" maxLength={128} onChange={(event) => setAccountEditor((current) => current ? { ...current, passwordConfirmation: event.target.value } : current)} required value={accountEditor.passwordConfirmation} />
        <Button htmlType="submit" type="primary">继续确认</Button>
      </form>}
    </Modal>
    <Modal open={accountConfirmationOpen} title="确认开通登录账号" okText="确认并开通" cancelText="返回修改" confirmLoading={accountBusy} onCancel={() => setAccountConfirmationOpen(false)} onOk={() => void confirmOpenAccount()}>
      <p>确认后将为「{accountEditor?.teacher.name}」开通登录账号 <strong>{accountEditor?.username.trim()}</strong>。请确认用户名无误，初始密码请妥善保存。</p>
    </Modal>
    <Modal open={Boolean(preview)} title={typeof preview?.display.title === 'string' ? preview.display.title : '确认操作'} footer={previewState === 'executed' ? <Button onClick={() => setPreview(null)}>关闭</Button> : <><Button disabled={previewState === 'confirming'} onClick={() => setPreview(null)}>关闭</Button>{previewState === 'unknown' ? <Button onClick={() => void recheck()}>重查状态</Button> : <Button disabled={previewState !== 'pending'} loading={previewState === 'confirming'} onClick={() => void confirm()} type="primary">确认执行</Button>}</>} onCancel={() => { if (previewState !== 'confirming') setPreview(null); }}>
      {preview && <div className="preview-summary"><Tag color={preview.riskLevel === 'L2' ? 'orange' : 'blue'}>{preview.riskLevel === 'L2' ? '高风险' : '低风险'}</Tag><p>{typeof preview.display.summary === 'string' ? preview.display.summary : '请核对下方操作后确认执行。'}</p><PreviewFacts value={preview.display} actionType={preview.actionType} /><p>预览有效期至 {preview.expiresAt}</p>{previewMessage && <Alert message={previewMessage} type={previewState === 'executed' ? 'success' : 'warning'} showIcon />}{receipt && <><strong>执行回执</strong><PreviewFacts value={receipt} actionType={preview.actionType} /></>}</div>}
    </Modal>
  </section>;
}
