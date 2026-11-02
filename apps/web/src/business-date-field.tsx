import { DatePicker } from 'antd';
import zhCNModule from 'antd/lib/date-picker/locale/zh_CN.js';
import { useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import 'dayjs/locale/zh-cn.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import localeData from 'dayjs/plugin/localeData.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import weekday from 'dayjs/plugin/weekday.js';
import weekOfYear from 'dayjs/plugin/weekOfYear.js';
import './business-date-field.css';

dayjs.extend(customParseFormat);
dayjs.extend(localeData);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(weekday);
dayjs.extend(weekOfYear);

export interface BusinessDateFieldProps {
  value: string;
  onChange: (value: string) => void;
  mode?: 'date' | 'datetime' | 'month' | undefined;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
}

const formats = { date: 'YYYY-MM-DD', datetime: 'YYYY-MM-DDTHH:mm', month: 'YYYY-MM' };

// These are wall-clock calendar values, not instants. UTC-backed Dayjs values
// keep browser DST/timezone rules out of parsing and calendar arithmetic. Only
// "now" is converted to Shanghai; the parent retains its existing +08:00 mapping.
function shanghaiNow(): Dayjs {
  return dayjs.utc(dayjs().tz('Asia/Shanghai').format('YYYY-MM-DDTHH:mm:ss.SSS'));
}

function parse(text: string, acceptedFormats: string[]): Dayjs | null {
  for (const format of acceptedFormats) {
    const parsed = dayjs.utc(text, format, true).locale('zh-cn');
    if (parsed.isValid()) return parsed;
  }
  return null;
}

// DatePicker.generatePicker is Ant Design's supported date-library adapter API.
// A local adapter also makes "today" highlights and empty panels use Shanghai,
// without setting a global default timezone for other consumers of Dayjs.
const calendar: Parameters<typeof DatePicker.generatePicker<Dayjs>>[0] = {
  getNow: shanghaiNow,
  getFixedDate: (text) => dayjs.utc(text),
  getEndDate: (value) => value.endOf('month'),
  getWeekDay: (value) => value.day(),
  getYear: (value) => value.year(),
  getMonth: (value) => value.month(),
  getDate: (value) => value.date(),
  getHour: (value) => value.hour(),
  getMinute: (value) => value.minute(),
  getSecond: (value) => value.second(),
  getMillisecond: (value) => value.millisecond(),
  addYear: (value, amount) => value.add(amount, 'year'),
  addMonth: (value, amount) => value.add(amount, 'month'),
  addDate: (value, amount) => value.add(amount, 'day'),
  setYear: (value, year) => value.year(year),
  setMonth: (value, month) => value.month(month),
  setDate: (value, date) => value.date(date),
  setHour: (value, hour) => value.hour(hour),
  setMinute: (value, minute) => value.minute(minute),
  setSecond: (value, second) => value.second(second),
  setMillisecond: (value, millisecond) => value.millisecond(millisecond),
  isAfter: (left, right) => left.isAfter(right),
  isValidate: (value) => value.isValid(),
  locale: {
    getWeekFirstDay: () => 1,
    getWeekFirstDate: (_locale, value) => value.locale('zh-cn').weekday(0),
    getWeek: (_locale, value) => value.locale('zh-cn').week(),
    getShortWeekDays: () => dayjs().locale('zh-cn').localeData().weekdaysMin(),
    getShortMonths: () => dayjs().locale('zh-cn').localeData().monthsShort(),
    format: (_locale, value, format) => value.locale('zh-cn').format(format),
    parse: (_locale, text, acceptedFormats) => parse(text, acceptedFormats),
  },
};

const ShanghaiDatePicker = DatePicker.generatePicker<Dayjs>(calendar);
// Ant Design publishes this subpath as CJS; Vite and native Node expose its
// default export at different depths.
const chineseLocale = (zhCNModule.default ?? zhCNModule) as typeof zhCNModule.default;

export function BusinessDateField({
  value, onChange, mode = 'date', id, 'aria-label': ariaLabel,
  required = false, disabled = false, placeholder, className,
}: BusinessDateFieldProps) {
  const [inputRevision, setInputRevision] = useState(0);
  const format = formats[mode];
  const inputFormats = mode === 'datetime' ? ['YYYY-MM-DD HH:mm', format] : [format];
  const selected = parse(value, [format]);
  const presets = mode === 'month'
    ? [{ label: '当前月份', value: () => shanghaiNow().startOf('month') }]
    : [
      { label: '今天', value: shanghaiNow },
      { label: '昨天', value: () => shanghaiNow().subtract(1, 'day') },
    ];

  return <ShanghaiDatePicker
    key={inputRevision}
    {...(id === undefined ? {} : { id })}
    {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
    required={required}
    disabled={disabled}
    className={['business-date-field', className].filter(Boolean).join(' ')}
    classNames={{ popup: { root: 'business-date-field-popup' } }}
    placeholder={placeholder ?? (mode === 'month' ? '选择月份或输入 YYYY-MM' : mode === 'datetime' ? '选择日期时间或输入 YYYY-MM-DD HH:mm' : '选择日期或输入 YYYY-MM-DD')}
    picker={mode === 'month' ? 'month' : 'date'}
    format={inputFormats}
    value={selected}
    onChange={(next) => {
      if (next) onChange(next.format(format));
      else if (!required) onChange('');
    }}
    onBlur={(event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.business-date-field-popup')) return;
      const text = event.target.value;
      const parsed = parse(text, inputFormats);
      // Commit a valid typed value in the blur event, before a following parent
      // form click/submit. The picker's deferred close effect runs too late.
      if (parsed && parsed.format(format) !== value) onChange(parsed.format(format));
      if (!text && !required && value) onChange('');
      // The picker preserves incomplete typed text internally. Restore the
      // controlled value after invalid input or a forbidden required clear.
      if ((!text && required && value) || (text && !parsed)) {
        setInputRevision((revision) => revision + 1);
      }
    }}
    allowClear={required ? false : { clearIcon: <span role="button" aria-label="清除日期">×</span> }}
    inputReadOnly={false}
    previewValue={false}
    showNow={false}
    needConfirm={mode === 'datetime'}
    // A semantic minuteStep=5 rounds existing minutes when selecting a date.
    // Keep all minutes valid, but offer five-minute choices in the visible list.
    showTime={mode === 'datetime' ? { format: 'HH:mm', use12Hours: false, showSecond: false, minuteStep: 1 } : false}
    cellRender={(current, info) => info.subType === 'minute' && typeof current === 'number' && current % 5 !== 0
      ? <span hidden data-business-minute-hidden />
      : info.originNode}
    locale={chineseLocale}
    presets={presets}
  />;
}
