import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import { verifySignedInternalRequest } from '@piano/assistant-protocol/internal-auth';
import { CoreDialogueError, DialogueReadClient } from '../src/tools/dialogue-tools.js';

const secret = 'unit-test-secret-012345678901234567890123';
const baseUrl = 'http://core.test/api/internal';

afterEach(() => vi.unstubAllGlobals());

describe('DialogueReadClient Core read routes', () => {
  const cases = [
    {
      name: 'directory',
      path: '/tools/directory',
      response: {
        students: [{ studentId: 'student-1', name: '小明', enrollmentStatus: 'STUDYING' }],
        teachers: [{ teacherId: 'teacher-1', name: '王老师', isActive: true }],
        courses: [{ courseId: 'course-1', name: '主课', isActive: true }],
      },
      call: (client: DialogueReadClient) => client.readDirectory('read-capability'),
    },
    {
      name: 'arrears and frozen students',
      path: '/tools/arrears-frozen',
      response: {
        arrears: [{ studentId: 'student-1', studentName: '小明', courseId: 'course-1', courseName: '主课', paidBalance: '-10.00' }],
        frozenStudents: [{ studentId: 'student-2', name: '小红' }],
      },
      call: (client: DialogueReadClient) => client.readArrearsAndFrozen('read-capability'),
    },
    {
      name: 'monthly consumption',
      path: '/tools/monthly-consumption?period=2026-10',
      response: {
        period: '2026-10',
        courses: [{ id: 'course-1', name: '主课', amount: '300.00' }],
        teachers: [{ id: 'teacher-1', name: '王老师', amount: '300.00' }],
        students: [{ id: 'student-1', name: '小明', amount: '300.00' }],
      },
      call: (client: DialogueReadClient) => client.readMonthlyConsumption('read-capability', { period: '2026-10' }),
    },
    {
      name: 'period preclose',
      path: '/tools/period-preclose?period=2026-10',
      response: {
        period: '2026-10', closed: false, pendingLessons: [], refundAnomalies: [],
        missingPayrollTeachers: [], ledgerAnomalies: [], reminders: [],
      },
      call: (client: DialogueReadClient) => client.readPeriodPreclose('read-capability', { period: '2026-10' }),
    },
  ] as const;

  it.each(cases)('calls and parses the $name response', async ({ path, response, call }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DialogueReadClient(baseUrl, 1_000, secret);

    await expect(call(client)).resolves.toEqual(response);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://core.test/api/internal${path}`);
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer read-capability');
    expect(verifySignedInternalRequest({
      secret,
      timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
      nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
      signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
      method: 'GET',
      path: `/api/internal${path}`,
      securityHeaders: { authorization: 'Bearer read-capability' },
    })).toBe(true);
  });

  it.each([
    ['readDirectory', (client: DialogueReadClient) => client.readDirectory('read-capability')],
    ['readArrearsAndFrozen', (client: DialogueReadClient) => client.readArrearsAndFrozen('read-capability')],
    ['readMonthlyConsumption', (client: DialogueReadClient) => client.readMonthlyConsumption('read-capability', { period: '2026-10' })],
    ['readPeriodPreclose', (client: DialogueReadClient) => client.readPeriodPreclose('read-capability', { period: '2026-10' })],
  ] as const)('maps Core errors consistently for %s', async (_method, call) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DialogueReadClient(baseUrl, 1_000, secret);

    await expect(call(client)).rejects.toMatchObject({
      name: 'CoreDialogueError',
      status: 403,
      message: '当前账号无权执行此操作',
    } satisfies Partial<CoreDialogueError>);
  });

  it('preserves a bounded Core 409 business reason for actionable recovery', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ statusCode:409,message:'老师在该时间段已有课程，排课时间冲突',code:'LESSON_TIME_CONFLICT' }), { status:409,headers:{'content-type':'application/json'} }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DialogueReadClient(baseUrl, 1_000, secret);
    await expect(client.readDirectory('read-capability')).rejects.toMatchObject({
      status:409,
      code:'LESSON_TIME_CONFLICT',
      message:'老师在该时间段已有课程，排课时间冲突',
    } satisfies Partial<CoreDialogueError>);
  });

  it('never exposes a Core 500 response body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message:'database connection string and stack trace' }), { status:500 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DialogueReadClient(baseUrl, 1_000, secret);
    await expect(client.readDirectory('read-capability')).rejects.toMatchObject({
      status:500,
      message:'业务服务暂时不可用，请稍后重试',
    } satisfies Partial<CoreDialogueError>);
  });
});
