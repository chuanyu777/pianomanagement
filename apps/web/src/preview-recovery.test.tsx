import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { UnknownConfirmationError } from './assistant-client.js';
import { PreviewDialog } from './structured-workbench.js';

it('recovers an executed confirmation without submitting the operation again', async () => {
  const user = userEvent.setup();
  const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
  const base = { previewId, actionType: 'student.create', schemaVersion: 'student.create.v1', riskLevel: 'L2' as const, expiresAt: '2099-10-21T02:00:00.000Z' };
  window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...base, status: ++reads === 1 ? 'PENDING' : 'EXECUTED', receipt: reads === 1 ? null : { studentId: 'student-1' } }), { status: 200 })));
  const confirm = vi.fn().mockRejectedValue(new UnknownConfirmationError('确认结果未知'));
  const recovered = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><PreviewDialog preview={{ ...base, status: 'PENDING', receipt: null, display: { title: '新增学生' }, success: '学生已创建', invalidate: [] }} onCancel={() => {}} onConfirm={confirm} onRecovered={recovered} /></QueryClientProvider>);
  expect(screen.queryByText(/预览有效期至/)).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '确认执行' }));
  await user.click(await screen.findByRole('button', { name: '重查状态' }));
  expect(await screen.findByText('执行回执')).toBeInTheDocument();
  expect(screen.queryByText(/预览有效期至/)).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(recovered).toHaveBeenCalledTimes(1);
});

it('keeps an unknown confirmation read-only when Core still reports pending', async () => {
  const user = userEvent.setup();
  const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
  const base = { previewId, actionType: 'student.create', schemaVersion: 'student.create.v1', riskLevel: 'L2' as const, expiresAt: '2099-10-21T02:00:00.000Z' };
  window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...base, status: 'PENDING', receipt: null }), { status: 200 })));
  const confirm = vi.fn().mockRejectedValue(new UnknownConfirmationError('确认结果未知'));
  render(<QueryClientProvider client={new QueryClient()}><PreviewDialog preview={{ ...base, status: 'PENDING', receipt: null, display: { title: '新增学生' }, success: '学生已创建', invalidate: [] }} onCancel={() => {}} onConfirm={confirm} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '确认执行' }));
  await user.click(await screen.findByRole('button', { name: '重查状态' }));
  expect(await screen.findByRole('button', { name: '重查状态' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(1);
});

it('does not reopen confirmation after an unknown result and dialog remount', async () => {
  const previewId = 'f83a5b21-d3a1-4190-842a-4eb6d6261e91';
  const base = { previewId, actionType: 'student.create', schemaVersion: 'student.create.v1', riskLevel: 'L2' as const, expiresAt: '2099-10-21T02:00:00.000Z' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...base, status: 'PENDING', receipt: null }), { status: 200 })));
  const confirm = vi.fn().mockRejectedValue(new UnknownConfirmationError('确认结果未知'));
  const client = new QueryClient();
  const element = <QueryClientProvider client={client}><PreviewDialog preview={{ ...base, status: 'PENDING', receipt: null, display: { title: '新增学生' }, success: '学生已创建', invalidate: [] }} onCancel={() => {}} onConfirm={confirm} /></QueryClientProvider>;
  const rendered = render(element);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
  await screen.findByRole('button', { name: '重查状态' });
  rendered.unmount();
  render(element);
  expect(await screen.findByRole('button', { name: '重查状态' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(1);
});

it('returns to the student page after a new success, but keeps a recovered receipt open', async () => {
  window.history.replaceState({}, '', '/students');
  try {
    const previewId = '7cd48606-d0b7-46cb-8e6d-f7cdb2743532';
    const base = { previewId, actionType: 'student.create', schemaVersion: 'student.create.v1', riskLevel: 'L1' as const, expiresAt: '2099-10-21T02:00:00.000Z' };
    let executed = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...base, status: executed ? 'EXECUTED' : 'PENDING', receipt: executed ? { name: '林同学' } : null }), { status: 200 })));
    const close = vi.fn();
    const element = <QueryClientProvider client={new QueryClient()}><PreviewDialog preview={{ ...base, status: 'PENDING', receipt: null, display: { title: '新增学生' }, success: '学生已创建', invalidate: [] }} onCancel={close} onConfirm={async () => ({ name: '林同学' })} closeOnSuccess /></QueryClientProvider>;
    const rendered = render(element);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(close).toHaveBeenCalledTimes(1);
    rendered.unmount();
    executed = true;
    render(element);
    expect(await screen.findByText('执行回执')).toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
  } finally { window.history.replaceState({}, '', '/'); }
});
