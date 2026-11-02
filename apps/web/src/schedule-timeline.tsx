import type { CSSProperties } from 'react';
import { Popover } from 'antd';
import type { components } from '@piano/generated-core-client/generated/core-api';
import { layoutScheduleDay, SCHEDULE_END_MINUTE, SCHEDULE_START_MINUTE } from './schedule-layout.js';
import './schedule-timeline.css';

type ListedLesson = components['schemas']['LessonListResponse'];

/** Accepts generated list responses and the workbench's existing minimal records. */
export type ScheduleTimelineLesson = Pick<ListedLesson, 'id' | 'startsAt' | 'endsAt'> & {
  student: Pick<ListedLesson['student'], 'name'>;
  course: Pick<ListedLesson['course'], 'name'>;
  teacher?: Pick<ListedLesson['teacher'], 'name'>;
  status?: string;
};

export type ScheduleTimelineProps = {
  lessons: readonly ScheduleTimelineLesson[];
  /** Shanghai calendar dates, YYYY-MM-DD, in display order. */
  days: readonly string[];
  /** Pass setSelectedLessonId to open the workbench's existing lesson actions. */
  onSelect: (lessonId: string) => void;
};

const PIXELS_PER_MINUTE = 0.8;
const GRID_HEIGHT = (SCHEDULE_END_MINUTE - SCHEDULE_START_MINUTE) * PIXELS_PER_MINUTE;
const HOURS = Array.from({ length: 16 }, (_, index) => index + 7);
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' });

function businessDate(value: Date) {
  const parts = date.formatToParts(value);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)?.value).join('-');
}

function fullTime(value: string) {
  const instant = new Date(value);
  return `${businessDate(instant).replaceAll('-', '/')} ${clock.format(instant)}`;
}

function statusText(status: string | undefined) {
  return ({ SCHEDULED: '待上课', COMPLETED: '已完成', CANCELLED: '已取消' } as Record<string, string>)[status ?? ''] ?? status ?? '状态未提供';
}

function teacherName(lesson: ScheduleTimelineLesson) {
  return lesson.teacher?.name || '教师信息未提供';
}

function timeRange(lesson: ScheduleTimelineLesson) {
  const startsAt = new Date(lesson.startsAt);
  const endsAt = new Date(lesson.endsAt);
  const end = businessDate(startsAt) === businessDate(endsAt) ? clock.format(endsAt) : fullTime(lesson.endsAt);
  return `${clock.format(startsAt)}—${end}`;
}

function LessonDetails({ lesson }: { lesson: ScheduleTimelineLesson }) {
  return <dl className="schedule-timeline-details">
    <dt>时间</dt><dd>{fullTime(lesson.startsAt)} — {fullTime(lesson.endsAt)}</dd>
    <dt>教师</dt><dd>{teacherName(lesson)}</dd>
    <dt>学生</dt><dd>{lesson.student.name}</dd>
    <dt>课程</dt><dd>{lesson.course.name}</dd>
    <dt>状态</dt><dd>{statusText(lesson.status)}</dd>
  </dl>;
}

function LessonButton({ lesson, onSelect, style, outside = false }: {
  lesson: ScheduleTimelineLesson;
  onSelect: ScheduleTimelineProps['onSelect'];
  style?: CSSProperties;
  outside?: boolean;
}) {
  const label = `${timeRange(lesson)} · ${teacherName(lesson)} · ${lesson.student.name} · ${lesson.course.name} · ${statusText(lesson.status)}`;
  const state = lesson.status === 'CANCELLED' ? 'is-cancelled' : lesson.status === 'COMPLETED' ? 'is-completed' : '';
  return <Popover content={<LessonDetails lesson={lesson} />} title="课程详情" trigger={['hover', 'focus', 'click']}>
    <button aria-label={label} className={`schedule-timeline-lesson ${outside ? 'is-outside' : ''} ${state}`} onClick={() => onSelect(lesson.id)} style={style} title={label} type="button">
      <time>{timeRange(lesson)}</time>
      <strong>{teacherName(lesson)}</strong>
      <span>{lesson.student.name} · {lesson.course.name}</span>
      <em>{statusText(lesson.status)}</em>
    </button>
  </Popover>;
}

export function ScheduleTimeline({ lessons, days, onSelect }: ScheduleTimelineProps) {
  const today = businessDate(new Date());
  const layouts = days.map((day) => ({ day, entries: layoutScheduleDay(lessons, day) }));
  const outsideDays = layouts.filter(({ entries }) => entries.some((entry) => entry.outside));
  const columns = layouts.map(({ entries }) => `minmax(${Math.max(112, ...entries.filter((entry) => !entry.outside).map((entry) => entry.columns * 112))}px, 1fr)`);
  return <div className="schedule-timeline" style={{ '--schedule-half-hour-height': `${30 * PIXELS_PER_MINUTE}px`, '--schedule-hour-height': `${60 * PIXELS_PER_MINUTE}px` } as CSSProperties}>
    <div aria-label="七天排课时间轴，上海时间7点至22点，可横向和纵向滚动" className="schedule-timeline-scroll" role="region" tabIndex={0}>
      <div className="schedule-timeline-grid" style={{ gridTemplateColumns: `48px ${columns.join(' ')}` }}>
        <div aria-hidden="true" className="schedule-timeline-axis">
          <div className="schedule-timeline-axis-head">时间</div>
          <div className="schedule-timeline-axis-body" style={{ height: GRID_HEIGHT }}>
            {HOURS.map((hour) => <span key={hour} style={{ top: (hour * 60 - SCHEDULE_START_MINUTE) * PIXELS_PER_MINUTE }}>{hour.toString().padStart(2, '0')}:00</span>)}
          </div>
        </div>
        {layouts.map(({ day, entries }) => <section aria-label={`${day}课程`} className={`schedule-timeline-day ${day === today ? 'is-today' : ''}`} key={day}>
          <header><span>{weekday.format(new Date(`${day}T00:00:00+08:00`))} <strong>{day.slice(5)}</strong></span><small>{entries.length} 节</small></header>
          <div className="schedule-timeline-lane" style={{ height: GRID_HEIGHT }}>
            {!entries.some((entry) => !entry.outside) && <span className="schedule-timeline-empty">{entries.length ? '课程在时间轴外' : '无排课'}</span>}
            {entries.filter((entry) => !entry.outside).map(({ lesson, startMinute, endMinute, column, columns: count }) => <LessonButton key={lesson.id} lesson={lesson} onSelect={onSelect} style={{
              top: (startMinute - SCHEDULE_START_MINUTE) * PIXELS_PER_MINUTE,
              height: (endMinute - startMinute) * PIXELS_PER_MINUTE,
              left: `calc(${column / count * 100}% + 3px)`,
              width: `calc(${100 / count}% - 6px)`,
            }} />)}
          </div>
        </section>)}
      </div>
    </div>
    {outsideDays.length > 0 && <section aria-label="时间轴外课程" className="schedule-timeline-outside">
      <h3>7:00—22:00 外的课程</h3>
      {outsideDays.map(({ day, entries }) => <div className="schedule-timeline-outside-day" key={day}>
        <h4>{day} {weekday.format(new Date(`${day}T00:00:00+08:00`))}</h4>
        <div>{entries.filter((entry) => entry.outside).map(({ lesson }) => <LessonButton key={lesson.id} lesson={lesson} onSelect={onSelect} outside />)}</div>
      </div>)}
    </section>}
  </div>;
}
