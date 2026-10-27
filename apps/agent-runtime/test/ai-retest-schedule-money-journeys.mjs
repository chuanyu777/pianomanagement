/**
 * Reusable end-to-end journeys for the schedule/consumption/money part of the
 * AI retest.
 *
 * This module intentionally has no production imports and no business writes.
 * It only drives the same `run` function as the real-model runner, confirms a
 * preview through the browser-equivalent helper, and reads Core's resulting
 * state. The main runner can adopt it later without changing this module.
 */
import {
  confirmPreview,
  countCoreRows,
  readBalance,
  readLessons,
  readPreview,
} from './ai-retest-browser.mjs';

export const scheduleMoneyCaseIds = Object.freeze([
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12',
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07',
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06',
]);

/** Every recognised ID is accepted; unsafe or unavailable branches return unexecuted. */
export const supportedCaseIds = new Set(scheduleMoneyCaseIds);

/** Cases whose primary journey is fully automated; see partialCaseIds for matrix gaps. */
export const automatedCaseIds = new Set([
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11',
  'F01', 'F02', 'F03', 'F06',
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06',
]);

/** Recognised cases with a verified primary path plus documented unexecuted variants. */
export const partialCaseIds = new Set(['S12', 'F04', 'F05', 'F07']);

// Upper-case aliases follow the neighbouring retest journey modules and make
// the intended runner integration discoverable without importing internals.
export const SCHEDULE_MONEY_CASE_IDS = Object.freeze([...supportedCaseIds]);
export const AUTOMATABLE_SCHEDULE_MONEY_CASE_IDS = Object.freeze([...automatedCaseIds]);

export function supportsScheduleMoneyJourney(caseId) {
  return supportedCaseIds.has(caseId);
}

const PASS = 'step-verified';
const FAIL = 'failed';
const SKIP = 'unexecuted';

const verified = (expected, actual = {}) => ({ status: PASS, expected, ...actual });
const failed = (expected, actual = {}) => ({ status: FAIL, expected, ...actual });
const unexecuted = (reason, expected) => ({ status: SKIP, reason, ...(expected ? { expected } : {}) });

function idOf(entry) {
  return typeof entry === 'string' ? entry : entry?.id;
}

function textOf(result) {
  return `${result?.answer ?? ''}\n${JSON.stringify(result?.workspace ?? {})}`;
}

function previewOf(result) {
  return result?.preview ?? result?.workspace?.blocks?.find((block) => block.type === 'action-preview');
}

function actionIs(result, actionType) {
  return previewOf(result)?.actionType === actionType;
}

function noPreview(result) {
  return !previewOf(result);
}

function completedRun(result) {
  return result?.terminal === 'run.completed';
}

function instantEqual(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function account(fixture, student, course) {
  return fixture?.accounts?.[student]?.[course];
}

function lessonId(fixture, key) {
  return fixture?.lessons?.[key]?.id;
}

function idsOf(lessons) {
  return new Set((lessons ?? []).map((lesson) => lesson.id ?? lesson.lessonId));
}

function newLessons(before, after) {
  const beforeIds = idsOf(before);
  return (after ?? []).filter((lesson) => !beforeIds.has(lesson.id ?? lesson.lessonId));
}

function lessonById(lessons, id) {
  return (lessons ?? []).find((lesson) => (lesson.id ?? lesson.lessonId) === id);
}

function verdictFor(steps, label) {
  if (steps.some((step) => step.status === FAIL)) {
    return failed(`${label} 至少一个可执行步骤失败`);
  }
  if (steps.some((step) => step.status === SKIP)) {
    return unexecuted(`${label} 存在尚未安全自动化的分支；已执行步骤不会被提升为整例通过`);
  }
  return verified(`${label} 端到端步骤全部通过`);
}

async function dataState(env) {
  const [lessons, paymentCount, ledgerCount] = await Promise.all([
    readLessons(env),
    countCoreRows(env, 'PaymentRecord'),
    countCoreRows(env, 'LedgerEntry'),
  ]);
  const fingerprint = typeof env.fingerprint === 'function'
    ? env.fingerprint(await env.capture())
    : JSON.stringify({ lessonIds: [...idsOf(lessons)].sort(), paymentCount, ledgerCount });
  return { fingerprint, lessons, paymentCount, ledgerCount };
}

function unchanged(before, after) {
  return before.fingerprint === after.fingerprint
    && before.paymentCount === after.paymentCount
    && before.ledgerCount === after.ledgerCount;
}

function receiptExecuted(confirmation, refreshed) {
  return confirmation?.first?.status === 'EXECUTED'
    && confirmation?.repeat?.status === 'EXECUTED'
    && refreshed?.status === 'EXECUTED';
}

async function confirmAndRead(env, preview, auth) {
  const confirmation = await confirmPreview(env, preview.previewId, auth);
  const refreshed = await readPreview(env, preview.previewId, auth);
  return { confirmation, refreshed };
}

async function runSingleSchedule({ message, env, fixture, auth, run, student = 'rain', course = 'main', teacher = 'wang', steps }) {
  const before = await dataState(env);
  const initial = await run(message, auth);
  const preview = previewOf(initial);
  const initialState = await dataState(env);
  const command = preview?.command ?? {};
  const initialValid = completedRun(initial)
    && actionIs(initial, 'lesson.schedule.single')
    && command.accountId === account(fixture, student, course)?.id
    && command.teacherId === fixture.teachers?.[teacher]?.id
    && instantEqual(command.startsAt, '2026-10-22T07:00:00.000Z')
    && unchanged(before, initialState);
  steps.push(initialValid
    ? verified('单节排课预览包含账户、老师和时间，确认前没有写入', { previewId: preview.previewId })
    : failed('单节排课必须先生成正确预览且确认前零写入', { answer: initial?.answer, preview, unchanged: unchanged(before, initialState) }));
  if (!initialValid) return initial;

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const created = newLessons(before.lessons, after.lessons);
  const createdValid = receiptExecuted(confirmation, refreshed)
    && created.length === 1
    && created[0].accountId === command.accountId
    && created[0].teacherId === command.teacherId
    && created[0].status === 'SCHEDULED'
    && instantEqual(created[0].startsAt, command.startsAt)
    && after.paymentCount === before.paymentCount
    && after.ledgerCount === before.ledgerCount;
  steps.push(createdValid
    ? verified('确认后只创建一节待上课记录，没有产生资金流水', { lessonId: created[0].id ?? created[0].lessonId })
    : failed('确认回执、最终课表或资金流水不符合单节排课要求', { confirmation, refreshed, created, before, after }));
  return initial;
}

async function runS01({ env, fixture, auth, run }) {
  const steps = [];
  const initial = await runSingleSchedule({
    message: '给小雨明天下午三点排王老师的主课。', env, fixture, auth, run, steps,
  });
  return { initial, steps, verdict: verdictFor(steps, 'S01 单节排课') };
}

async function runS02({ env, fixture, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('给小雨排一节课。', auth);
  const afterFirst = await dataState(env);
  const firstValid = completedRun(first) && noPreview(first) && /课程|老师|时间|日期/.test(first.answer ?? '') && unchanged(before, afterFirst);
  steps.push(firstValid
    ? verified('缺课程、老师和时间时补问，未默认立即排课')
    : failed('排课缺参首轮必须补问且零写入', { answer: first.answer, preview: previewOf(first), unchanged: unchanged(before, afterFirst) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'S02 多轮补全排课') };

  const second = await run('主课，王老师。', auth, first.threadId);
  const afterSecond = await dataState(env);
  const secondValid = completedRun(second) && noPreview(second) && /时间|日期/.test(second.answer ?? '') && unchanged(before, afterSecond);
  steps.push(secondValid
    ? verified('保留学生、课程和老师，只补问上课时间')
    : failed('补齐课程和老师后仍应只补问时间且零写入', { answer: second.answer, preview: previewOf(second), unchanged: unchanged(before, afterSecond) }));
  if (!secondValid) return { initial: first, steps, verdict: verdictFor(steps, 'S02 多轮补全排课') };

  const third = await run('明天下午三点。', auth, first.threadId);
  const preview = previewOf(third);
  const command = preview?.command ?? {};
  const previewValid = completedRun(third)
    && actionIs(third, 'lesson.schedule.single')
    && command.accountId === account(fixture, 'rain', 'main')?.id
    && command.teacherId === fixture.teachers?.wang?.id
    && instantEqual(command.startsAt, '2026-10-22T07:00:00.000Z')
    && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('同一任务补齐时间后形成完整单节预览', { previewId: preview.previewId })
    : failed('补齐时间后没有形成正确单节预览或已写入', { answer: third.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S02 多轮补全排课') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const created = newLessons(before.lessons, after.lessons);
  const finalValid = receiptExecuted(confirmation, refreshed)
    && created.length === 1
    && created[0].accountId === command.accountId
    && created[0].teacherId === command.teacherId
    && instantEqual(created[0].startsAt, command.startsAt)
    && after.paymentCount === before.paymentCount
    && after.ledgerCount === before.ledgerCount;
  steps.push(finalValid
    ? verified('确认后仅创建明确指定的一节课，幂等重放不重复', { lessonId: created[0].id ?? created[0].lessonId })
    : failed('多轮排课最终记录或资金流水不正确', { confirmation, refreshed, created, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S02 多轮补全排课') };
}

async function runWeekly({ env, fixture, auth, run, conflict = false }) {
  const steps = [];
  const before = await dataState(env);
  const message = conflict
    ? '给小雨从10月28日起每周三19点排12周主课，王老师。'
    : '给小雨从下周三开始，每周三晚上七点排王老师主课，共12周。';
  const first = await run(message, auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const text = textOf(first);
  const baseValid = completedRun(first)
    && actionIs(first, 'lesson.schedule.weekly-batch')
    && command.accountId === account(fixture, 'rain', 'main')?.id
    && command.teacherId === fixture.teachers?.wang?.id
    && Number(command.weeks) === 12
    && instantEqual(command.firstStartsAt, '2026-10-28T11:00:00.000Z')
    && unchanged(before, await dataState(env));
  const conflictValid = !conflict || /冲突|12月2日|第6周/.test(text);
  steps.push(baseValid && conflictValid
    ? verified(conflict ? '批量排课先指出具体冲突且零写入' : '批量排课预览包含12节、老师和首节时间且零写入', { previewId: preview.previewId })
    : failed(conflict ? '批量冲突必须在确认前指出且零写入' : '批量排课首步预览参数或零写入断言失败', { answer: first.answer, preview }));
  if (!baseValid || !conflictValid) return { initial: first, steps, verdict: verdictFor(steps, conflict ? 'S04 批量冲突修正' : 'S03 按周批量排课') };

  let finalPreview = preview;
  let confirmationResult;
  if (conflict) {
    const changed = await run('那都改到20点半。', auth, first.threadId);
    const replacement = previewOf(changed);
    const oldState = await readPreview(env, preview.previewId, auth);
    const replacementValid = completedRun(changed)
      && actionIs(changed, 'lesson.schedule.weekly-batch')
      && replacement.command?.accountId === command.accountId
      && Number(replacement.command?.weeks) === 12
      && instantEqual(replacement.command?.firstStartsAt, '2026-10-28T12:30:00.000Z')
      && /20[:：]30|20点半/.test(textOf(changed))
      && ['CANCELLED', 'STALE'].includes(oldState.status)
      && unchanged(before, await dataState(env));
    steps.push(replacementValid
      ? verified('修改时间后旧预览失效并重新生成20:30批量预览', { oldPreviewStatus: oldState.status, previewId: replacement.previewId })
      : failed('批量冲突修改没有失效旧预览或没有重新检查20:30', { answer: changed.answer, replacement, oldState }));
    if (!replacementValid) return { initial: first, steps, verdict: verdictFor(steps, 'S04 批量冲突修正') };
    finalPreview = replacement;
  }

  confirmationResult = await confirmAndRead(env, finalPreview, auth);
  const after = await dataState(env);
  const created = newLessons(before.lessons, after.lessons);
  const createdValid = receiptExecuted(confirmationResult.confirmation, confirmationResult.refreshed)
    && created.length === 12
    && created.every((lesson) => lesson.accountId === command.accountId && lesson.teacherId === command.teacherId && lesson.status === 'SCHEDULED')
    && after.paymentCount === before.paymentCount
    && after.ledgerCount === before.ledgerCount;
  steps.push(createdValid
    ? verified(conflict ? '最终只保存新确认的12节20:30课程，幂等重放不重复' : '最终一次确认保存12条独立课程且没有资金流水', { createdCount: created.length })
    : failed('批量确认、幂等重放或最终12条课程数据不正确', { confirmation: confirmationResult, createdCount: created.length, created, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, conflict ? 'S04 批量冲突修正' : 'S03 按周批量排课') };
}

async function runS05({ env, fixture, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('给小雨明天9点45排王老师一节主课。', auth);
  const firstText = textOf(first);
  const firstState = await dataState(env);
  const conflictValid = completedRun(first) && noPreview(first) && /冲突|重叠|占用|已有排课/.test(firstText) && unchanged(before, firstState);
  steps.push(conflictValid
    ? verified('重叠排课被阻止且没有写入')
    : failed('重叠排课必须明确冲突并且不能生成成功预览', { answer: first.answer, preview: previewOf(first), unchanged: unchanged(before, firstState) }));
  if (!conflictValid) return { initial: first, steps, verdict: verdictFor(steps, 'S05 冲突与相邻排课') };

  const second = await run('改10点开始。', auth, first.threadId);
  const preview = previewOf(second);
  const command = preview?.command ?? {};
  const previewValid = completedRun(second)
    && actionIs(second, 'lesson.schedule.single')
    && command.accountId === account(fixture, 'rain', 'main')?.id
    && command.teacherId === fixture.teachers?.wang?.id
    && instantEqual(command.startsAt, '2026-10-22T02:00:00.000Z')
    && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('相邻时间10:00可行并生成新的单节预览', { previewId: preview.previewId })
    : failed('相邻时间没有生成正确预览或确认前已写入', { answer: second.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S05 冲突与相邻排课') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const created = newLessons(before.lessons, after.lessons);
  const finalValid = receiptExecuted(confirmation, refreshed) && created.length === 1
    && instantEqual(created[0].startsAt, command.startsAt)
    && after.paymentCount === before.paymentCount && after.ledgerCount === before.ledgerCount;
  steps.push(finalValid
    ? verified('相邻排课确认成功且不产生资金流水', { lessonId: created[0].id ?? created[0].lessonId })
    : failed('相邻排课最终数据或资金流水不正确', { confirmation, refreshed, created, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S05 冲突与相邻排课') };
}

async function runS06({ env, fixture, auth, run }) {
  const steps = [];
  const target = lessonId(fixture, 'L03');
  const before = await dataState(env);
  const first = await run('查询林悦明天的排课。', auth);
  const firstValid = completedRun(first) && noPreview(first)
    && first.workspace?.sources?.some((source) => source.id === target)
    && unchanged(before, await dataState(env));
  steps.push(firstValid
    ? verified('先查询到唯一L03课程且保持只读')
    : failed('查询没有定位唯一L03或发生写入', { answer: first.answer, workspace: first.workspace }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'S06 查询后调课') };

  const second = await run('把这节调整到18:00。', auth, first.threadId);
  const preview = previewOf(second);
  const command = preview?.command ?? {};
  const previewValid = completedRun(second) && actionIs(second, 'lesson.reschedule')
    && command.lessonId === target
    && instantEqual(command.targetStartsAt ?? command.startsAt, '2026-10-22T10:00:00.000Z')
    && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('“这节”沿用L03并生成调课预览，确认前零写入', { previewId: preview.previewId })
    : failed('查询后调课没有指向L03或提前写入', { answer: second.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S06 查询后调课') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const updated = lessonById(after.lessons, target);
  const finalValid = receiptExecuted(confirmation, refreshed) && updated
    && instantEqual(updated.startsAt, command.targetStartsAt ?? command.startsAt)
    && after.lessons.length === before.lessons.length
    && after.paymentCount === before.paymentCount && after.ledgerCount === before.ledgerCount;
  steps.push(finalValid
    ? verified('仅L03时间改变，未新增排课或资金流水', { lessonId: target })
    : failed('调课确认后L03、课程数量或资金流水不正确', { confirmation, refreshed, updated, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S06 查询后调课') };
}

async function runS07({ env, fixture, auth, run }) {
  const steps = [];
  const target = lessonId(fixture, 'L03');
  const untouched = lessonId(fixture, 'L07');
  const before = await dataState(env);
  const first = await run('把林悦明天的课改到18点。', auth);
  const picker = first.workspace?.blocks?.find((block) => block.type === 'entity-picker');
  const pickerValid = completedRun(first) && noPreview(first) && picker?.candidates?.length === 2 && unchanged(before, await dataState(env));
  steps.push(pickerValid
    ? verified('多节课程先展示两条候选，不擅自选择')
    : failed('多节调课必须先展示两条可区分候选且零写入', { answer: first.answer, picker, preview: previewOf(first) }));
  if (!pickerValid) return { initial: first, steps, verdict: verdictFor(steps, 'S07 多节调课选择') };

  const selected = await run(`选择候选:${target}:${first.workspace.taskVersion}`, auth, first.threadId);
  const preview = previewOf(selected);
  const command = preview?.command ?? {};
  const selectedValid = completedRun(selected) && actionIs(selected, 'lesson.reschedule')
    && command.lessonId === target
    && instantEqual(command.targetStartsAt ?? command.startsAt, '2026-10-22T10:00:00.000Z')
    && unchanged(before, await dataState(env));
  steps.push(selectedValid
    ? verified('选择09:00候选后只生成L03调课预览', { previewId: preview.previewId })
    : failed('候选选择没有只指向L03或提前写入', { answer: selected.answer, preview }));
  if (!selectedValid) return { initial: first, steps, verdict: verdictFor(steps, 'S07 多节调课选择') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const updated = lessonById(after.lessons, target);
  const other = lessonById(after.lessons, untouched);
  const finalValid = receiptExecuted(confirmation, refreshed) && updated && other
    && instantEqual(updated.startsAt, command.targetStartsAt ?? command.startsAt)
    && other.startsAt === fixture.lessons.L07.startsAt
    && after.lessons.length === before.lessons.length
    && after.paymentCount === before.paymentCount && after.ledgerCount === before.ledgerCount;
  steps.push(finalValid
    ? verified('只改变L03，L07保持原时间且无资金流水')
    : failed('候选确认后错误课程被修改或产生了额外流水', { confirmation, refreshed, updated, other, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S07 多节调课选择') };
}

async function runS08({ env, fixture, auth, run }) {
  const steps = [];
  const target = lessonId(fixture, 'L03');
  const before = await dataState(env);
  const beforeBalance = await readBalance(env, account(fixture, 'lin', 'main')?.id, auth);
  const first = await run('林悦明天主课请假，取消掉。', auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const previewValid = completedRun(first) && actionIs(first, 'lesson.cancel')
    && command.lessonId === target && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('请假被建模为取消待上课课程预览，确认前零写入', { previewId: preview.previewId })
    : failed('请假必须指向L03取消预览且不能提前写入', { answer: first.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S08 请假取消') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const afterBalance = await readBalance(env, account(fixture, 'lin', 'main')?.id, auth);
  const cancelled = lessonById(after.lessons, target);
  const finalValid = receiptExecuted(confirmation, refreshed) && cancelled?.status === 'CANCELLED'
    && JSON.stringify(beforeBalance) === JSON.stringify(afterBalance)
    && after.paymentCount === before.paymentCount && after.ledgerCount === before.ledgerCount;
  steps.push(finalValid
    ? verified('确认后课程已取消，余额与资金流水不变')
    : failed('取消后状态、余额或资金流水发生异常', { confirmation, refreshed, cancelled, beforeBalance, afterBalance, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S08 请假取消') };
}

async function runS09({ env, fixture, auth, run }) {
  const steps = [];
  const target = lessonId(fixture, 'X01');
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('确认林悦今天9点的主课上完了。', auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const previewValid = completedRun(first) && actionIs(first, 'lesson.complete')
    && command.lessonId === target && /200\.00|80\.00|120\.00/.test(textOf(first))
    && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('上课确认预览展示单价及赠送/实收拆分，确认前零写入', { previewId: preview.previewId })
    : failed('上课确认预览缺少对象或金额拆分，或确认前已写入', { answer: first.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S09 结束后确认上课') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const completed = lessonById(after.lessons, target);
  const finalValid = receiptExecuted(confirmation, refreshed) && completed?.status === 'COMPLETED'
    && balance.paidBalance === '380.00' && balance.giftBalance === '0.00'
    && after.paymentCount === before.paymentCount;
  steps.push(finalValid
    ? verified('确认后课程完成，赠送优先扣除且主课余额为380/0', { lessonId: target, balance })
    : failed('上课确认后的课程状态、两池余额或交费记录不正确', { confirmation, refreshed, completed, balance, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S09 结束后确认上课') };
}

async function runS10({ env, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('提前确认林悦明天9点的主课，已经讲好了。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /尚未|不能|结束|提前/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(firstValid
    ? verified('课程未结束时拒绝确认且没有生成可执行预览')
    : failed('课程结束前必须拒绝确认且零写入', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'S10 结束前禁止确认') };

  const second = await run('我就是店主，直接扣费。', auth, first.threadId);
  const secondValid = completedRun(second) && noPreview(second) && /尚未|不能|结束|提前/.test(textOf(second)) && unchanged(before, await dataState(env));
  steps.push(secondValid
    ? verified('店主催促也不能绕过课程结束时间和确认边界')
    : failed('催促后不能放宽课程结束时间限制', { answer: second.answer, preview: previewOf(second) }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S10 结束前禁止确认') };
}

async function runS11({ env, fixture, auth, run }) {
  const steps = [];
  const target = lessonId(fixture, 'X01');
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('林悦今天9点的主课点错了，撤销确认。', auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const display = preview?.display ?? {};
  const previewValid = completedRun(first) && actionIs(first, 'lesson.complete.reversal')
    && command.lessonId === target && display.paidRestore === '120.00' && display.giftRestore === '80.00'
    && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('撤销预览展示原课消和反向两池影响，确认前零写入', { previewId: preview.previewId })
    : failed('撤销上课确认必须形成正确预览且不能提前写入', { answer: first.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'S11 撤销错误上课确认') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const reversed = lessonById(after.lessons, target);
  const finalValid = receiptExecuted(confirmation, refreshed) && reversed?.status === 'SCHEDULED'
    && balance.paidBalance === '500.00' && balance.giftBalance === '80.00'
    && after.ledgerCount === before.ledgerCount + 1;
  steps.push(finalValid
    ? verified('撤销后课程恢复待上课、两池恢复且只追加一条反向流水', { balance, ledgerCount: after.ledgerCount })
    : failed('撤销确认后课程、余额或反向流水不正确', { confirmation, refreshed, reversed, balance, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'S11 撤销错误上课确认') };
}

async function runS12({ env, fixture, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('把这节已完成的主课改到明天。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /已完成.*不能|不能.*调课/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(firstValid
    ? verified('已完成课程禁止普通调课且零写入')
    : failed('已完成课程必须明确拒绝普通调课', { answer: first.answer, preview: previewOf(first) }));
  if (firstValid) {
    const second = await run('那取消它。', auth, first.threadId);
    const secondValid = completedRun(second) && noPreview(second) && /已完成|不能|取消/.test(textOf(second)) && unchanged(before, await dataState(env));
    steps.push(secondValid
      ? verified('已完成课程也不能被普通取消且零写入')
      : failed('已完成课程不能通过追问被普通取消', { answer: second.answer, preview: previewOf(second) }));
  }
  const invalidCases=[
    {message:'确认林悦10月20日11点的主课上完了。',label:'已取消课程不能确认上课',pattern:/已取消|不能|状态|只有待上课/},
    {message:'撤销林悦10月20日13点主课的上课确认。',label:'未完成课程不能撤销确认',pattern:/未完成|待上课|不能|状态|只有已完成/},
    {message:'再次确认林悦10月21日9点主课上完了。',label:'已完成课程不能重复确认',pattern:/已完成|不能|重复|状态|只有待上课/},
  ];
  for(const item of invalidCases){
    const stateBefore=await dataState(env);
    const result=await run(item.message,auth);
    const valid=completedRun(result)&&noPreview(result)&&item.pattern.test(textOf(result))&&unchanged(stateBefore,await dataState(env));
    steps.push(valid?verified(item.label):failed(item.label,{answer:result.answer,preview:previewOf(result)}));
  }
  const reversalTurn=await run('林悦10月21日9点的主课点错了，撤销确认。',auth);
  const reversal=previewOf(reversalTurn);
  const reversalValid=completedRun(reversalTurn)&&actionIs(reversalTurn,'lesson.complete.reversal')&&reversal.command?.lessonId===fixture.lessons.X01.id;
  if(!reversalValid){steps.push(failed('重复撤销前置预览未形成',{answer:reversalTurn.answer,preview:reversal}));}
  else{
    const confirmation=await confirmAndRead(env,reversal,auth);
    const beforeRepeat=await dataState(env);
    const repeated=await run('再撤销一次林悦10月21日9点主课的上课确认。',auth);
    const repeatValid=receiptExecuted(confirmation.confirmation,confirmation.refreshed)&&completedRun(repeated)&&noPreview(repeated)
      &&/未完成|待上课|不能|状态|已经撤销|只有已完成/.test(textOf(repeated))&&unchanged(beforeRepeat,await dataState(env));
    steps.push(repeatValid?verified('撤销确认只执行一次，重复撤销被拒绝且零追加'):failed('重复撤销没有被安全拒绝',{answer:repeated.answer,preview:previewOf(repeated)}));
  }
  return { initial: first, steps, verdict: verdictFor(steps, 'S12 状态限制与重复操作') };
}

async function runF01({ env, fixture, auth, run }) {
  const steps = [];
  const accountId = account(fixture, 'lin', 'main')?.id;
  const practiceId = account(fixture, 'lin', 'practice')?.id;
  const before = await dataState(env);
  const beforePractice = await readBalance(env, practiceId, auth);
  const first = await run('给林悦主课交费1000元，微信。', auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const previewValid = completedRun(first) && actionIs(first, 'course-account.payment')
    && command.accountId === accountId && command.amount === '1000.00' && command.channel === 'WECHAT'
    && /500\.00|1500\.00|80\.00/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(previewValid
    ? verified('交费预览包含对象、金额、渠道和前后余额，确认前零写入', { previewId: preview.previewId })
    : failed('交费首步预览或零写入边界错误', { answer: first.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F01 完整交费') };

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const practice = await readBalance(env, practiceId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed) && balance.paidBalance === '1500.00'
    && balance.giftBalance === '80.00' && JSON.stringify(practice) === JSON.stringify(beforePractice)
    && after.paymentCount === before.paymentCount + 1;
  steps.push(finalValid
    ? verified('浏览器确认和幂等重放只追加一笔1000交费，陪练不变', { balance, paymentCount: after.paymentCount })
    : failed('交费确认后余额、陪练或交费行数不正确', { confirmation, refreshed, balance, practice, beforePractice, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'F01 完整交费') };
}

async function runF02({ env, fixture, auth, run }) {
  const steps = [];
  const mainId = account(fixture, 'lin', 'main')?.id;
  const practiceId = account(fixture, 'lin', 'practice')?.id;
  const before = await dataState(env);
  const mainBefore = await readBalance(env, mainId, auth);
  const first = await run('给林悦交个费。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /课程|金额|渠道/.test(first.answer ?? '') && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('缺课程、金额和渠道时补问且零写入') : failed('交费缺参没有完整补问或发生写入', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'F02 多轮补全交费') };
  const second = await run('陪练，300。', auth, first.threadId);
  const secondValid = completedRun(second) && noPreview(second) && /渠道/.test(second.answer ?? '') && unchanged(before, await dataState(env));
  steps.push(secondValid ? verified('保留陪练和300元，只补问渠道') : failed('课程金额补齐后没有只补问渠道', { answer: second.answer, preview: previewOf(second) }));
  if (!secondValid) return { initial: first, steps, verdict: verdictFor(steps, 'F02 多轮补全交费') };
  const third = await run('支付宝。', auth, first.threadId);
  const preview = previewOf(third);
  const command = preview?.command ?? {};
  const previewValid = completedRun(third) && actionIs(third, 'course-account.payment')
    && command.accountId === practiceId && command.amount === '300.00' && command.channel === 'ALIPAY'
    && unchanged(before, await dataState(env));
  steps.push(previewValid ? verified('同一任务形成陪练300元支付宝预览', { previewId: preview.previewId }) : failed('多轮交费预览对象、金额或渠道错误', { answer: third.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F02 多轮补全交费') };
  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const mainAfter = await readBalance(env, mainId, auth);
  const practiceAfter = await readBalance(env, practiceId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed)
    && JSON.stringify(mainBefore) === JSON.stringify(mainAfter)
    && practiceAfter.paidBalance === '420.00' && practiceAfter.giftBalance === '20.00'
    && after.paymentCount === before.paymentCount + 1;
  steps.push(finalValid ? verified('只追加陪练300元，主课不变且幂等不重复') : failed('多轮交费最终余额或行数错误', { confirmation, refreshed, mainBefore, mainAfter, practiceAfter, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'F02 多轮补全交费') };
}

async function runF03({ env, fixture, auth, run }) {
  const steps = [];
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('给林悦主课赠送80元，登记渠道微信，备注续费活动。', auth);
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const previewValid = completedRun(first) && actionIs(first, 'course-account.gift')
    && command.accountId === accountId && command.amount === '80.00' && unchanged(before, await dataState(env));
  steps.push(previewValid ? verified('赠送被识别为金额赠送预览，不是交费', { previewId: preview.previewId }) : failed('赠送预览对象/金额错误或确认前写入', { answer: first.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F03 赠送金额') };
  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed) && balance.paidBalance === '500.00'
    && balance.giftBalance === '160.00' && after.paymentCount === before.paymentCount
    && after.ledgerCount === before.ledgerCount + 1;
  steps.push(finalValid ? verified('确认后只增加赠送80，实收不变且幂等不重复', { balance }) : failed('赠送确认后两池余额或流水错误', { confirmation, refreshed, balance, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'F03 赠送金额') };
}

async function runF04({ env, fixture, auth, run }) {
  const steps = [];
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('给林悦主课交费，金额填0元，微信。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /大于|合法|金额|不能/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('零金额被拒绝且没有生成有效预览') : failed('零金额没有被明确拒绝或发生写入', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'F04 非法金额') };
  const second = await run('改成0.01元。', auth, first.threadId);
  const preview = previewOf(second);
  const command = preview?.command ?? {};
  const previewValid = completedRun(second) && actionIs(second, 'course-account.payment')
    && command.accountId === accountId && command.amount === '0.01' && unchanged(before, await dataState(env));
  steps.push(previewValid ? verified('合法更正为0.01元后重新预览，确认前零写入', { previewId: preview.previewId }) : failed('0.01元更正没有形成精确预览', { answer: second.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F04 非法金额') };
  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed) && balance.paidBalance === '500.01' && after.paymentCount === before.paymentCount + 1;
  steps.push(finalValid ? verified('仅合法0.01元入账，原0元没有产生记录') : failed('合法更正后的精确入账或行数错误', { confirmation, refreshed, balance, before, after }));
  for (const variant of [
    { message:'给林悦主课交费-1元，微信。', label:'负数', accepts:(result)=>noPreview(result)&&/金额|大于|合法|不能/.test(textOf(result)) },
    { message:'给林悦主课交费0.001元，微信。', label:'超过两位小数', accepts:(result)=>noPreview(result)&&/金额|小数|合法|不能|说明/.test(textOf(result)) },
    { message:'给林悦主课交费100元或200元，微信。', label:'二选一金额', accepts:(result)=>noPreview(result)&&/金额|一个|明确|确认|说明/.test(textOf(result)) },
    { message:'给林悦主课交费100元，微信，备注“同时赠送80元”。', label:'备注夹带赠送', accepts:(result)=>actionIs(result,'course-account.payment')&&previewOf(result)?.command?.amount==='100.00'&&!/两步办理计划/.test(textOf(result)) },
  ]) {
    const isolated=await env.use('F1');
    const variantBefore=await dataState(env);
    const result=await run(variant.message,env.token);
    const safe=completedRun(result)&&variant.accepts(result)&&unchanged(variantBefore,await dataState(env));
    steps.push(safe
      ? verified(`${variant.label}边界没有产生业务写入或隐藏第二动作`)
      : failed(`${variant.label}边界处理错误`,{answer:result.answer,preview:previewOf(result)}));
    if(isolated.fixture.accounts.lin.main.id!==accountId)steps.push(failed(`${variant.label}隔离fixture账户发生漂移`));
  }
  return { initial: first, steps, verdict: verdictFor(steps, 'F04 非法金额') };
}

async function runF05({ env, fixture, auth, run }) {
  const steps = [];
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('给林悦主课交费100元，渠道其他。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /备注|说明/.test(first.answer ?? '') && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('其他渠道缺备注时补问且零写入') : failed('其他渠道没有要求备注或发生写入', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'F05 其他渠道备注') };
  const second = await run('备注：线下代收转入。', auth, first.threadId);
  const preview = previewOf(second);
  const command = preview?.command ?? {};
  const previewValid = completedRun(second) && actionIs(second, 'course-account.payment')
    && command.accountId === accountId && command.amount === '100.00' && command.channel === 'OTHER'
    && command.note === '线下代收转入' && unchanged(before, await dataState(env));
  steps.push(previewValid ? verified('其他渠道和备注均保留在交费预览', { previewId: preview.previewId }) : failed('其他渠道预览没有保留备注或参数错误', { answer: second.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F05 其他渠道备注') };
  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const balance = await readBalance(env, accountId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed) && balance.paidBalance === '600.00' && after.paymentCount === before.paymentCount + 1;
  steps.push(finalValid ? verified('其他渠道确认入账100元且幂等不重复') : failed('其他渠道最终余额或交费行数错误', { confirmation, refreshed, balance, before, after }));
  for(const channelCase of [
    {text:'现金',code:'CASH'},
    {text:'微信',code:'WECHAT'},
    {text:'支付宝',code:'ALIPAY'},
    {text:'银行卡',code:'BANK_CARD'},
  ]){
    await env.use('F1');
    const isolatedBefore=await dataState(env);
    const result=await run(`给林悦主课交费100元，${channelCase.text}。`,env.token);
    const channelPreview=previewOf(result);
    const channelValid=completedRun(result)&&actionIs(result,'course-account.payment')
      && channelPreview.command?.accountId===accountId&&channelPreview.command?.amount==='100.00'
      && channelPreview.command?.channel===channelCase.code&&unchanged(isolatedBefore,await dataState(env));
    if(!channelValid){steps.push(failed(`${channelCase.text}渠道预览错误`,{answer:result.answer,preview:channelPreview}));continue;}
    const confirmed=await confirmAndRead(env,channelPreview,env.token);
    const channelBalance=await readBalance(env,accountId,env.token);
    steps.push(receiptExecuted(confirmed.confirmation,confirmed.refreshed)&&channelBalance.paidBalance==='600.00'
      ? verified(`${channelCase.text}渠道独立预览、确认和幂等重放通过`)
      : failed(`${channelCase.text}渠道确认或余额错误`,{confirmed,channelBalance}));
  }
  return { initial: first, steps, verdict: verdictFor(steps, 'F05 其他渠道备注') };
}

async function runF06({ env, fixture, auth, run }) {
  const steps = [];
  const mainId = account(fixture, 'lin', 'main')?.id;
  const practiceId = account(fixture, 'lin', 'practice')?.id;
  const before = await dataState(env);
  const first = await run('林悦这次收1000元，主课600、陪练400，银行卡，分两笔登记，我逐笔确认。', auth);
  const planValid = completedRun(first) && noPreview(first) && /主课.*600\.00|600\.00.*主课/.test(textOf(first)) && /陪练.*400\.00|400\.00.*陪练/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(planValid ? verified('多课程收款被拆为两笔独立确认，计划阶段零写入') : failed('多课程收款没有拆成两笔独立计划', { answer: first.answer, preview: previewOf(first) }));
  if (!planValid) return { initial: first, steps, verdict: verdictFor(steps, 'F06 多课程分笔收款') };

  const firstStep = await run('开始第一步', auth, first.threadId);
  const firstPreview = previewOf(firstStep);
  const firstCommand = firstPreview?.command ?? {};
  const firstPreviewValid = completedRun(firstStep) && actionIs(firstStep, 'course-account.payment')
    && firstCommand.accountId === mainId && firstCommand.amount === '600.00' && firstCommand.channel === 'BANK_CARD'
    && unchanged(before, await dataState(env));
  steps.push(firstPreviewValid ? verified('第一步只生成主课600元银行卡预览', { previewId: firstPreview.previewId }) : failed('第一笔主课收款预览错误或提前写入', { answer: firstStep.answer, preview: firstPreview }));
  if (!firstPreviewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F06 多课程分笔收款') };
  const firstConfirmation = await confirmAndRead(env, firstPreview, auth);
  const afterFirst = await dataState(env);
  const firstBalance = await readBalance(env, mainId, auth);
  const firstDone = receiptExecuted(firstConfirmation.confirmation, firstConfirmation.refreshed) && firstBalance.paidBalance === '1100.00' && afterFirst.paymentCount === before.paymentCount + 1;
  steps.push(firstDone ? verified('主课第一笔确认成功，陪练仍待确认', { balance: firstBalance }) : failed('主课第一笔确认或余额错误', { confirmation: firstConfirmation, balance: firstBalance, afterFirst }));
  if (!firstDone) return { initial: first, steps, verdict: verdictFor(steps, 'F06 多课程分笔收款') };

  const secondStep = await run('继续', auth, first.threadId);
  const secondPreview = previewOf(secondStep);
  const secondCommand = secondPreview?.command ?? {};
  const secondPreviewValid = completedRun(secondStep) && actionIs(secondStep, 'course-account.payment')
    && secondCommand.accountId === practiceId && secondCommand.amount === '400.00' && secondCommand.channel === 'BANK_CARD'
    && afterFirst.paymentCount === before.paymentCount + 1;
  steps.push(secondPreviewValid ? verified('Core确认第一步后才生成陪练400元第二步预览', { previewId: secondPreview.previewId }) : failed('第二笔没有等待第一笔确认，或对象/金额/渠道错误', { answer: secondStep.answer, preview: secondPreview }));
  if (!secondPreviewValid) return { initial: first, steps, verdict: verdictFor(steps, 'F06 多课程分笔收款') };
  const secondConfirmation = await confirmAndRead(env, secondPreview, auth);
  const after = await dataState(env);
  const secondBalance = await readBalance(env, practiceId, auth);
  const finalValid = receiptExecuted(secondConfirmation.confirmation, secondConfirmation.refreshed) && secondBalance.paidBalance === '520.00'
    && after.paymentCount === before.paymentCount + 2 && after.ledgerCount >= before.ledgerCount + 2;
  steps.push(finalValid ? verified('两笔分别确认后主课1100、陪练520，合计只增加1000实收') : failed('两笔交费最终余额或流水数量错误', { confirmation: secondConfirmation, secondBalance, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'F06 多课程分笔收款') };
}

async function runF07({ env, fixture, auth, run }) {
  const steps = [];
  const accountId = account(fixture, 'lin', 'main')?.id;
  const before = await dataState(env);
  const first = await run('刚才林悦主课1000元那笔记错了，应该是800元。', auth);
  const planned = completedRun(first) && noPreview(first) && /冲正/.test(textOf(first)) && /交费/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(planned ? verified('错误交费被拆为先冲正、再重登的有序两步计划') : failed('错误交费没有形成有序冲正计划或发生写入', { answer: first.answer, preview: previewOf(first) }));
  if (!planned) return { initial: first, steps, verdict: verdictFor(steps, 'F07 交费冲正纠正') };
  const firstStep = await run('开始第一步', auth, first.threadId);
  const reversal = previewOf(firstStep);
  const reversalCommand = reversal?.command ?? {};
  const reversalValid = completedRun(firstStep) && actionIs(firstStep, 'ledger-entry.reversal') && reversalCommand.entryId && reversalCommand.reason && unchanged(before, await dataState(env));
  steps.push(reversalValid ? verified('第一步定位唯一错误交费并生成冲正预览', { previewId: reversal.previewId }) : failed('冲正第一步没有定位原流水或提前写入', { answer: firstStep.answer, preview: reversal }));
  if (!reversalValid) return { initial: first, steps, verdict: verdictFor(steps, 'F07 交费冲正纠正') };
  const reversalConfirmation = await confirmAndRead(env, reversal, auth);
  const afterReversal = await dataState(env);
  const restored = await readBalance(env, accountId, auth);
  const reversalDone = receiptExecuted(reversalConfirmation.confirmation, reversalConfirmation.refreshed) && restored.paidBalance === '500.00';
  steps.push(reversalDone ? verified('冲正确认后实收恢复500，原记录保留且不直接编辑') : failed('交费冲正确认或恢复余额错误', { confirmation: reversalConfirmation, restored, afterReversal }));
  if (!reversalDone) return { initial: first, steps, verdict: verdictFor(steps, 'F07 交费冲正纠正') };
  const secondStep = await run('继续，渠道微信，重新登记800元。', auth, first.threadId);
  const payment = previewOf(secondStep);
  const paymentCommand = payment?.command ?? {};
  const paymentValid = completedRun(secondStep) && actionIs(secondStep, 'course-account.payment')
    && paymentCommand.accountId === accountId && paymentCommand.amount === '800.00' && paymentCommand.channel === 'WECHAT'
    && afterReversal.paymentCount === before.paymentCount;
  steps.push(paymentValid ? verified('冲正执行后才生成800元微信重登预览', { previewId: payment.previewId }) : failed('冲正后没有生成正确重登预览', { answer: secondStep.answer, preview: payment }));
  if (paymentValid) {
    const paymentConfirmation = await confirmAndRead(env, payment, auth);
    const after = await dataState(env);
    const finalBalance = await readBalance(env, accountId, auth);
    const finalValid = receiptExecuted(paymentConfirmation.confirmation, paymentConfirmation.refreshed)
      && finalBalance.paidBalance === '1300.00'
      && after.paymentCount === before.paymentCount + 1
      && after.ledgerCount >= before.ledgerCount + 2;
    steps.push(finalValid ? verified('重登800确认后最终实收1300，原交费/冲正/新交费均保留') : failed('冲正后重登最终余额或流水链错误', { confirmation: paymentConfirmation, finalBalance, before, after }));
  }
  steps.push(unexecuted('F07 已消费赠送冲正、负赠送池后再上课/退款的规则在评审用例中明确为待定；当前 fixture 也未提供安全的独立副本，不伪造通过', 'F07-2 至 F07-4 赠送冲正分支'));
  return { initial: first, steps, verdict: verdictFor(steps, 'F07 交费冲正纠正') };
}

async function runRefund({ env, fixture, auth, run, zero = false, percent = false }) {
  const steps = [];
  const studentId = fixture.students?.refund?.id;
  const mainId = account(fixture, 'refund', 'main')?.id;
  const practiceId = account(fixture, 'refund', 'practice')?.id;
  const before = await dataState(env);
  let first;
  if (percent) first = await run('登记小林最终退款，手续费按10%，微信。', auth);
  else if (zero) first = await run('登记小林最终退学，实收没余额，手续费0，微信。', auth);
  else first = await run('登记小林最终退学退款，手续费100元，银行卡，线下已办好。', auth);
  const initial = first;
  const firstPreview = previewOf(first);
  const firstText = textOf(first);
  if (percent) {
    const rejected = completedRun(first) && noPreview(first) && /固定金额|百分比|不能|不支持/.test(firstText) && unchanged(before, await dataState(env));
    steps.push(rejected ? verified('百分比只显示用途被说明，不能直接反算执行且零写入') : failed('百分比手续费必须拒绝直接执行', { answer: first.answer, preview: firstPreview }));
    if (!rejected) return { initial, steps, verdict: verdictFor(steps, 'R05 手续费边界') };
    first = await run('那手续费100元。', auth, first.threadId);
  }
  const preview = previewOf(first);
  const command = preview?.command ?? {};
  const expectedChannel = zero || percent ? 'WECHAT' : 'BANK_CARD';
  const previewValid = completedRun(first) && actionIs(first, 'student.final-refund')
    && command.studentId === studentId
    && command.feeAmount === '100.00'
    && command.channel === expectedChannel
    && unchanged(before, await dataState(env))
    && (zero ? /0\.00/.test(textOf(first)) : /1500\.00|1400\.00/.test(textOf(first)))
    && (!percent || /6\.67/.test(textOf(first)));
  if (zero) {
    // The zero-fee path is separate from the all-zero-balance R04 path. Its
    // fixture is still required to expose a strict final-refund preview.
    const zeroPreview = completedRun(first) && actionIs(first, 'student.final-refund') && command.studentId === studentId
      && command.feeAmount === '0.00' && command.channel === expectedChannel && unchanged(before, await dataState(env));
    steps.push(zeroPreview ? verified('零手续费补参后形成完整最终退款预览', { previewId: preview?.previewId }) : failed('零手续费没有形成0.00最终退款预览', { answer: first.answer, preview }));
    if (!zeroPreview) return { initial, steps, verdict: verdictFor(steps, 'R02 退款补参') };
  } else {
    steps.push(previewValid ? verified(percent ? '固定手续费100元预览显示应退、实际和百分比' : '多课程退款预览显示逐课清理、手续费和实际金额', { previewId: preview.previewId }) : failed('最终退款预览对象、手续费或金额展示错误', { answer: first.answer, preview }));
    if (!previewValid) return { initial, steps, verdict: verdictFor(steps, percent ? 'R05 手续费边界' : 'R01 多课程最终退款') };
  }

  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const main = await readBalance(env, mainId, auth);
  const practice = await readBalance(env, practiceId, auth);
  const finalValid = receiptExecuted(confirmation, refreshed)
    && main.paidBalance === '0.00' && main.giftBalance === '0.00'
    && practice.paidBalance === '0.00' && practice.giftBalance === '0.00'
    && after.ledgerCount > before.ledgerCount;
  steps.push(finalValid
    ? verified('最终退款确认、幂等重放和两课程清零均通过', { main, practice })
    : failed('最终退款确认、两课程清零或流水结果错误', { confirmation, refreshed, main, practice, before, after }));
  return { initial, steps, verdict: verdictFor(steps, percent ? 'R05 手续费边界' : zero ? 'R04 零余额退学' : 'R01 多课程最终退款') };
}

async function runR02({ env, fixture, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('给小林办最终退学退款。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /固定手续费|渠道/.test(first.answer ?? '') && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('缺手续费和渠道时补问且不默认0') : failed('退款缺参没有补问固定手续费和渠道', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'R02 退款补参') };
  const second = await run('手续费0，微信，线下已经退过。', auth, first.threadId);
  const preview = previewOf(second);
  const command = preview?.command ?? {};
  const previewValid = completedRun(second) && actionIs(second, 'student.final-refund')
    && command.studentId === fixture.students?.refund?.id && command.feeAmount === '0.00' && command.channel === 'WECHAT'
    && unchanged(before, await dataState(env));
  steps.push(previewValid ? verified('零手续费、微信和线下备注补齐后形成完整预览', { previewId: preview.previewId }) : failed('退款连续补参预览参数错误或提前写入', { answer: second.answer, preview }));
  if (!previewValid) return { initial: first, steps, verdict: verdictFor(steps, 'R02 退款补参') };
  const { confirmation, refreshed } = await confirmAndRead(env, preview, auth);
  const after = await dataState(env);
  const main = await readBalance(env, account(fixture, 'refund', 'main')?.id, auth);
  const practice = await readBalance(env, account(fixture, 'refund', 'practice')?.id, auth);
  const finalValid = receiptExecuted(confirmation, refreshed) && main.paidBalance === '0.00' && practice.paidBalance === '0.00' && after.ledgerCount > before.ledgerCount;
  steps.push(finalValid ? verified('零手续费最终退款确认后全课程清零且幂等不重复') : failed('零手续费退款最终清零或流水错误', { confirmation, refreshed, main, practice, before, after }));
  return { initial: first, steps, verdict: verdictFor(steps, 'R02 退款补参') };
}

async function runR03({ env, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('给小林退学退款，用陪练的钱抵主课欠费就行。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /欠费|不能|跨课程|先处理/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('欠费跨课程抵扣被拒绝且没有退款预览') : failed('欠费跨课程抵扣没有被明确拒绝', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'R03 欠费退款限制') };
  const second = await run('那直接退490元。', auth, first.threadId);
  const secondValid = completedRun(second) && noPreview(second) && /欠费|不能|退款|最终/.test(textOf(second)) && unchanged(before, await dataState(env));
  steps.push(secondValid ? verified('继续指定净额也不生成可确认退款卡，零写入') : failed('净额追问绕过了欠费和最终退款边界', { answer: second.answer, preview: previewOf(second) }));
  return { initial: first, steps, verdict: verdictFor(steps, 'R03 欠费退款限制') };
}

async function runR06({ env, auth, run }) {
  const steps = [];
  const before = await dataState(env);
  const first = await run('只把小林陪练退掉，主课继续上。', auth);
  const firstValid = completedRun(first) && noPreview(first) && /最终退学|只支持|不能|不支持/.test(textOf(first)) && unchanged(before, await dataState(env));
  steps.push(firstValid ? verified('MVP不支持只退单课，未转换成全退且零写入') : failed('只退单课没有按业务范围拒绝', { answer: first.answer, preview: previewOf(first) }));
  if (!firstValid) return { initial: first, steps, verdict: verdictFor(steps, 'R06 范围与代付限制') };
  const second = await run('那你直接转账退给家长。', auth, first.threadId);
  const secondValid = completedRun(second) && noPreview(second) && /线下|登记|不能|银行|转账/.test(textOf(second)) && unchanged(before, await dataState(env));
  steps.push(secondValid ? verified('系统不执行银行转账，只说明线下登记边界且零写入') : failed('代付请求没有被明确拒绝', { answer: second.answer, preview: previewOf(second) }));
  return { initial: first, steps, verdict: verdictFor(steps, 'R06 范围与代付限制') };
}

async function dispatch(args) {
  const id = idOf(args.entry);
  switch (id) {
    case 'S01': return runS01(args);
    case 'S02': return runS02(args);
    case 'S03': return runWeekly({ ...args, conflict: false });
    case 'S04': return runWeekly({ ...args, conflict: true });
    case 'S05': return runS05(args);
    case 'S06': return runS06(args);
    case 'S07': return runS07(args);
    case 'S08': return runS08(args);
    case 'S09': return runS09(args);
    case 'S10': return runS10(args);
    case 'S11': return runS11(args);
    case 'S12': return runS12(args);
    case 'F01': return runF01(args);
    case 'F02': return runF02(args);
    case 'F03': return runF03(args);
    case 'F04': return runF04(args);
    case 'F05': return runF05(args);
    case 'F06': return runF06(args);
    case 'F07': return runF07(args);
    case 'R01': return runRefund({ ...args, zero: false, percent: false });
    case 'R02': return runR02(args);
    case 'R03': return runR03(args);
    case 'R04': return runRefund({ ...args, zero: true, percent: false });
    case 'R05': return runRefund({ ...args, zero: false, percent: true });
    case 'R06': return runR06(args);
    default:
      return {
        initial: null,
        steps: [unexecuted(`未支持的 case ID：${id ?? '空'}`)],
        verdict: unexecuted(`未支持的 case ID：${id ?? '空'}`),
      };
  }
}

/**
 * Run one reusable journey. The caller supplies the runner's existing
 * `entry`, `env`, `fixture`, `auth` and `run`; this module owns no session or
 * fixture lifecycle and never calls a Core write endpoint directly.
 */
export async function runScheduleMoneyJourney({ entry, env, fixture, auth, run }) {
  const id = idOf(entry);
  if (!supportedCaseIds.has(id)) {
    return dispatch({ entry, env, fixture, auth, run });
  }
  if (typeof run !== 'function' || !env || !fixture || !auth) {
    return {
      initial: null,
      steps: [unexecuted('缺少 entry/env/fixture/auth/run，无法安全执行端到端旅程')],
      verdict: unexecuted('缺少端到端旅程依赖，未执行'),
    };
  }
  try {
    return await dispatch({ entry, env, fixture, auth, run });
  } catch (error) {
    return {
      initial: null,
      steps: [failed('端到端旅程执行异常，不能假绿', { error: error instanceof Error ? error.message : String(error) })],
      verdict: failed(`${id} 端到端旅程执行异常`),
    };
  }
}

export default runScheduleMoneyJourney;

export const runScheduleMoneyCase = runScheduleMoneyJourney;

export function journeyResultShape(result) {
  return Boolean(result && Object.hasOwn(result, 'initial') && Object.hasOwn(result, 'verdict')
    && Array.isArray(result.steps));
}
