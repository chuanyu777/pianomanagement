import { StrictMode } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleTimeline } from './schedule-timeline.js';

const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
const previousWeek = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const onSelect = vi.fn();

function timeline(displayDays = days, selectedLessonId = '') {
  return <StrictMode><ScheduleTimeline lessons={[]} days={displayDays} onSelect={onSelect} selectedLessonId={selectedLessonId} /></StrictMode>;
}

function viewport() {
  return screen.getByRole('region', { name: /七天排课时间轴/ });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Shanghai Wednesday 14:30. Geometry represents a narrow viewport.
  vi.setSystemTime(new Date('2026-11-04T06:30:00Z'));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(272);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(792);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(832);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'HEADER' ? 60 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('schedule-timeline-axis') ? 48 : 112;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('schedule-timeline-day')) return 0;
    return 48 + Array.from(this.parentElement!.children).indexOf(this) * 112 - 112;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('current time in the Shanghai schedule', () => {
  it('draws the true time only in today’s lane and initially scrolls both axes', () => {
    render(timeline());
    const line = screen.getByLabelText('当前时间 14:30');
    expect(within(screen.getByRole('region', { name: '2026-11-04课程' })).getByLabelText('当前时间 14:30')).toBe(line);
    expect(line).toHaveStyle({ top: '360px' });
    expect(screen.getAllByLabelText(/当前时间/)).toHaveLength(1);
    expect(viewport().scrollLeft).toBe(224);
    expect(viewport().scrollTop).toBe(240);
  });

  it('updates at the next minute without stealing scroll on ticks or same-week rerenders', () => {
    vi.setSystemTime(new Date('2026-11-04T06:30:45Z'));
    const view = render(timeline());
    expect(screen.getByLabelText('当前时间 14:30')).toBeInTheDocument();
    viewport().scrollTop = 19;
    viewport().scrollLeft = 31;
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByLabelText('当前时间 14:31')).toHaveStyle({ top: '360.8px' });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByLabelText('当前时间 14:32')).toBeInTheDocument();
    view.rerender(timeline([...days]));
    expect(viewport().scrollTop).toBe(19);
    expect(viewport().scrollLeft).toBe(31);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['2026-11-03T22:59:00Z', 0], // Shanghai 06:59
    ['2026-11-04T14:01:00Z', 492], // Shanghai 22:01
  ])('locates the nearest boundary outside 07–22 without drawing a false line (%s)', (instant, top) => {
    vi.setSystemTime(new Date(instant));
    render(timeline());
    expect(screen.queryByLabelText(/当前时间/)).not.toBeInTheDocument();
    expect(viewport().scrollTop).toBe(top);
    expect(viewport().scrollLeft).toBe(224);
  });

  it.each([
    ['2026-11-03T23:00:00Z', '07:00', '0px'],
    ['2026-11-04T14:00:00Z', '22:00', '720px'],
  ])('shows the actual time at the exact visible boundary (%s)', (instant, label, top) => {
    vi.setSystemTime(new Date(instant));
    render(timeline());
    expect(screen.getByLabelText(`当前时间 ${label}`)).toHaveStyle({ top });
    act(() => { vi.advanceTimersByTime(60_000); });
    if (label === '22:00') expect(screen.queryByLabelText(/当前时间/)).not.toBeInTheDocument();
    else expect(screen.getByLabelText('当前时间 07:01')).toBeInTheDocument();
  });

  it('leaves other weeks untouched and resets initial positioning when switching back', () => {
    const view = render(timeline(previousWeek));
    expect(screen.queryByLabelText(/当前时间/)).not.toBeInTheDocument();
    expect(viewport().scrollTop).toBe(0);
    expect(viewport().scrollLeft).toBe(0);
    view.rerender(timeline());
    expect(viewport().scrollTop).toBe(240);
    viewport().scrollTop = 12;
    view.rerender(timeline(previousWeek));
    expect(screen.queryByLabelText(/当前时间/)).not.toBeInTheDocument();
    expect(viewport().scrollTop).toBe(12);
    view.rerender(timeline());
    expect(viewport().scrollTop).toBe(240);
    expect(viewport().scrollLeft).toBe(224);
  });

  it('respects an explicit lesson deep link even while lessons are still loading', () => {
    const view = render(timeline(days, 'linked-lesson'));
    expect(screen.getByLabelText('当前时间 14:30')).toBeInTheDocument();
    expect(viewport().scrollTop).toBe(0);
    expect(viewport().scrollLeft).toBe(0);
    view.rerender(timeline());
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(viewport().scrollTop).toBe(0);
    expect(viewport().scrollLeft).toBe(0);
    view.rerender(timeline(previousWeek));
    view.rerender(timeline());
    expect(viewport().scrollTop).toBeGreaterThan(0);
  });

  it('moves today across Shanghai midnight without starting another automatic scroll', () => {
    vi.setSystemTime(new Date('2026-11-03T15:59:00Z'));
    render(timeline());
    expect(screen.getByRole('region', { name: '2026-11-03课程' })).toHaveClass('is-today');
    viewport().scrollTop = 21;
    viewport().scrollLeft = 33;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole('region', { name: '2026-11-04课程' })).toHaveClass('is-today');
    expect(screen.getByRole('region', { name: '2026-11-03课程' })).not.toHaveClass('is-today');
    expect(screen.queryByLabelText(/当前时间/)).not.toBeInTheDocument();
    expect(viewport().scrollTop).toBe(21);
    expect(viewport().scrollLeft).toBe(33);
  });
});
