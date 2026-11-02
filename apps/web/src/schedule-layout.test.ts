import { describe, expect, it } from 'vitest';
import { layoutScheduleDay } from './schedule-layout.js';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduleTimeline } from './schedule-timeline.js';

describe('schedule timeline', () => {
  it('keeps simultaneous and partially overlapping lessons in distinct columns', () => {
    const entries = layoutScheduleDay([
      { id: 'a', startsAt: '2026-10-30T10:00:00+08:00', endsAt: '2026-10-30T11:00:00+08:00' },
      { id: 'b', startsAt: '2026-10-30T10:00:00+08:00', endsAt: '2026-10-30T10:45:00+08:00' },
      { id: 'c', startsAt: '2026-10-30T10:30:00+08:00', endsAt: '2026-10-30T11:30:00+08:00' },
    ], '2026-10-30');
    expect(entries.map((entry) => entry.column)).toEqual([0, 1, 2]);
    expect(entries.every((entry) => entry.columns === 3)).toBe(true);
    expect(entries[0]?.startMinute).toBe(600);
  });

  it('clips cross-boundary lessons while retaining outside lessons separately', () => {
    const entries = layoutScheduleDay([
      { id: 'early', startsAt: '2026-10-30T06:30:00+08:00', endsAt: '2026-10-30T07:30:00+08:00' },
      { id: 'late', startsAt: '2026-10-30T23:00:00+08:00', endsAt: '2026-10-30T23:45:00+08:00' },
    ], '2026-10-30');
    expect(entries[0]).toMatchObject({ startMinute: 420, endMinute: 450, outside: false });
    expect(entries[1]).toMatchObject({ outside: true });
  });

  it('only includes lessons intersecting the Shanghai calendar day, including overnight lessons', () => {
    const entries = layoutScheduleDay([
      { id: 'overnight', startsAt: '2026-10-29T15:30:00Z', endsAt: '2026-10-29T16:30:00Z' },
      { id: 'previous', startsAt: '2026-10-29T14:00:00Z', endsAt: '2026-10-29T16:00:00Z' },
      { id: 'next', startsAt: '2026-10-30T16:00:00Z', endsAt: '2026-10-30T17:00:00Z' },
    ], '2026-10-30');
    expect(entries.map(({ lesson }) => lesson.id)).toEqual(['overnight']);
    expect(entries[0]?.outside).toBe(true);
  });

  it('clips both endpoints to the visible window and retains exact boundary lessons outside it', () => {
    const entries = layoutScheduleDay([
      { id: 'early', startsAt: '2026-10-30T06:00:00+08:00', endsAt: '2026-10-30T07:00:00+08:00' },
      { id: 'late', startsAt: '2026-10-30T22:00:00+08:00', endsAt: '2026-10-30T23:00:00+08:00' },
      { id: 'spanning', startsAt: '2026-10-30T06:30:00+08:00', endsAt: '2026-10-30T22:30:00+08:00' },
    ], '2026-10-30');
    expect(entries.find(({ lesson }) => lesson.id === 'early')).toMatchObject({ startMinute: 420, endMinute: 420, outside: true });
    expect(entries.find(({ lesson }) => lesson.id === 'late')).toMatchObject({ startMinute: 1320, endMinute: 1320, outside: true });
    expect(entries.find(({ lesson }) => lesson.id === 'spanning')).toMatchObject({ startMinute: 420, endMinute: 1320, outside: false });
  });

  it('reuses lanes for touching lessons and resets the column count after an overlap group', () => {
    const entries = layoutScheduleDay([
      { id: 'a', startsAt: '2026-10-30T10:00:00+08:00', endsAt: '2026-10-30T11:00:00+08:00' },
      { id: 'b', startsAt: '2026-10-30T10:30:00+08:00', endsAt: '2026-10-30T11:30:00+08:00' },
      { id: 'c', startsAt: '2026-10-30T11:00:00+08:00', endsAt: '2026-10-30T11:15:00+08:00' },
      { id: 'd', startsAt: '2026-10-30T12:00:00+08:00', endsAt: '2026-10-30T12:05:00+08:00' },
    ], '2026-10-30');
    expect(entries.map(({ column, columns }) => [column, columns])).toEqual([[0, 2], [1, 2], [0, 2], [0, 1]]);
    expect(entries[3]).toMatchObject({ startMinute: 720, endMinute: 725 });
  });
});

describe('ScheduleTimeline', () => {
  it('positions simultaneous teachers separately, preserves short duration, and exposes complete details', async () => {
    const selected: string[] = [];
    const lessons = [
      { id: 'short', startsAt: '2026-10-30T02:00:00Z', endsAt: '2026-10-30T02:05:00Z', status: 'SCHEDULED', student: { name: '小明' }, course: { name: '钢琴主课' }, teacher: { name: '王老师' } },
      { id: 'long', startsAt: '2026-10-30T02:00:00Z', endsAt: '2026-10-30T03:00:00Z', status: 'SCHEDULED', student: { name: '小红' }, course: { name: '陪练' }, teacher: { name: '李老师' } },
    ];
    render(createElement(ScheduleTimeline, { lessons, days: ['2026-10-30'], onSelect: (id) => selected.push(id) }));
    const short = screen.getByRole('button', { name: /10:00.*10:05.*王老师.*小明.*钢琴主课/ });
    const long = screen.getByRole('button', { name: /李老师.*小红.*陪练/ });
    expect(short.style.top).toBe('144px');
    expect(short.style.height).toBe('4px');
    expect(long.style.height).toBe('48px');
    expect(short.style.left).not.toBe(long.style.left);
    fireEvent.click(short);
    expect(selected).toEqual(['short']);
    expect(await screen.findByText('课程详情')).toBeInTheDocument();
    expect(screen.getByText('2026/10/30 10:00 — 2026/10/30 10:05')).toBeInTheDocument();
  });

  it('keeps early and late lessons selectable and announces clipped lessons using their true times', () => {
    const lessons = [
      { id: 'early', startsAt: '2026-10-30T06:00:00+08:00', endsAt: '2026-10-30T07:00:00+08:00', student: { name: '早课学生' }, course: { name: '主课' } },
      { id: 'clipped', startsAt: '2026-10-30T21:30:00+08:00', endsAt: '2026-10-30T22:30:00+08:00', student: { name: '跨界学生' }, course: { name: '主课' } },
      { id: 'late', startsAt: '2026-10-30T23:00:00+08:00', endsAt: '2026-10-30T23:45:00+08:00', student: { name: '晚课学生' }, course: { name: '主课' } },
    ];
    const selected: string[] = [];
    render(createElement(ScheduleTimeline, { lessons, days: ['2026-10-30'], onSelect: (id) => selected.push(id) }));
    fireEvent.click(screen.getByRole('button', { name: /06:00.*07:00.*早课学生/ }));
    fireEvent.click(screen.getByRole('button', { name: /23:00.*23:45.*晚课学生/ }));
    expect(selected).toEqual(['early', 'late']);
    expect(screen.getByText('7:00—22:00 外的课程')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /21:30.*22:30.*跨界学生/ }).style.height).toBe('24px');
    expect(screen.getAllByRole('button', { name: /教师信息未提供/ })).toHaveLength(3);
  });
});
