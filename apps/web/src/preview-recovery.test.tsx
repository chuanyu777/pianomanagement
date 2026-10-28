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
  await waitFor(() => expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '确认执行' }));
  await user.click(await screen.findByRole('button', { name: '重查状态' }));
  expect(await screen.findByText('执行回执')).toBeInTheDocument();
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
