import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessDateField, type BusinessDateFieldProps } from './business-date-field.js';

function Field({ value = '', onChange = vi.fn(), ...props }: Partial<BusinessDateFieldProps>) {
  const [current, setCurrent] = useState(value);
  return <><BusinessDateField aria-label="业务日期" {...props} value={current} onChange={(next) => { setCurrent(next); onChange(next); }} /><button type="button">移出焦点</button></>;
}

async function enter(value: string) {
  const user = userEvent.setup();
  const input = screen.getByRole('textbox');
  await user.clear(input);
  if (value) await user.type(input, value);
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('button', { name: '移出焦点' }));
}

describe('BusinessDateField (real Ant Design calendar)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // November in Shanghai, still October in UTC and American browser timezones.
    vi.setSystemTime(new Date('2026-10-31T16:07:00Z'));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('forwards labels, id, required and className, and accepts explicit undefined optional props', () => {
    render(<label htmlFor="lesson-date">上课日期<BusinessDateField value="2026-10-30" onChange={vi.fn()} id="lesson-date" required className="custom-date" mode={undefined} disabled={undefined} placeholder={undefined} aria-label={undefined} /></label>);
    const input = screen.getByLabelText('上课日期');
    expect(input).toHaveValue('2026-10-30');
    expect(input).toBeRequired();
    expect(input.closest('.business-date-field')).toHaveClass('custom-date');
    expect((input as HTMLInputElement).type).toBe('text');
  });

  it('shows Chinese years, months, weekdays and selects an actual calendar day', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await waitFor(() => expect(screen.getByText('2026年')).toBeVisible());
    expect(screen.getByText('10月')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: '一' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: '日' })).toBeVisible();
    await userEvent.click(screen.getByTitle('2026-10-28'));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28');
    expect(screen.getByRole('textbox')).toHaveValue('2026-10-28');
  });

  it('supports fast year/month navigation without changing value until a day is selected', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByText('2026年'));
    await userEvent.click(screen.getByTitle('2025'));
    await userEvent.click(screen.getByTitle('2025-02'));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTitle('2025-02-18'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('2025-02-18'));
  });

  it.each([
    ['date', '2028-02-29', '2028-02-29'],
    ['month', '2027-02', '2027-02'],
    ['datetime', '2026-03-08 02:17', '2026-03-08T02:17'],
    ['datetime', '2026-12-31T23:59', '2026-12-31T23:59'],
  ] as const)('accepts keyboard input in %s mode without shifting or rounding', async (mode, typed, expected) => {
    const onChange = vi.fn();
    render(<Field mode={mode} onChange={onChange} />);
    await enter(typed);
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(screen.getByRole('textbox')).toHaveValue(expected.replace('T', ' '));
  });

  it.each(['date', 'datetime', 'month'] as const)('commits valid %s keyboard input on Enter without needing blur', async (mode) => {
    const onChange = vi.fn();
    const typed = { date: '2026-10-28', datetime: '2026-10-28T10:37', month: '2026-10' }[mode];
    render(<Field mode={mode} onChange={onChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), typed);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(typed));
  });

  it.each(['date', 'datetime', 'month'] as const)('commits valid %s keyboard input on blur without Enter', async (mode) => {
    const onChange = vi.fn();
    const typed = { date: '2026-10-28', datetime: '2026-10-28T10:37', month: '2026-10' }[mode];
    render(<Field mode={mode} onChange={onChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), typed);
    await user.click(screen.getByRole('button', { name: '移出焦点' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(typed));
  });

  it('submits the newly typed time when clicking the parent form submit button immediately', async () => {
    const onSubmit = vi.fn();
    function Form() {
      const [value, setValue] = useState('2026-10-30T13:17');
      return <form onSubmit={(event) => { event.preventDefault(); onSubmit(value); }}>
        <BusinessDateField mode="datetime" aria-label="业务发生时间" value={value} onChange={setValue} />
        <button type="submit">生成确认单</button>
      </form>;
    }
    render(<Form />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('业务发生时间'));
    await user.type(screen.getByLabelText('业务发生时间'), '2026-10-28T10:30');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('2026-10-28T10:30');
  });

  it.each(['2026-10-28T24:30', '2026-10-28T10:60', '2026-10-28T10:301', '2026-10-28T10:3'])('does not commit invalid/incomplete datetime %s on blur', async (typed) => {
    const onChange = vi.fn();
    render(<Field mode="datetime" value="2026-10-30T13:17" onChange={onChange} />);
    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), typed);
    await user.click(screen.getByRole('button', { name: '移出焦点' }));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('2026-10-30 13:17'));
  });

  it('allows selecting a calendar day after a required value has been erased with the keyboard', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" required onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.click(screen.getByTitle('2026-10-28'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('2026-10-28'));
  });

  it.each(['2026-02-30', '2026-13-01', '2026-04-31'])('rejects invalid date %s instead of silently rolling it over', async (typed) => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    await enter(typed);
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('2026-10-30'));
  });

  it('does not change the date on hover or when opening and closing the panel', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox'));
    await user.hover(screen.getByTitle('2026-10-28'));
    expect(screen.getByRole('textbox')).toHaveValue('2026-10-30');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '移出焦点' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([['今天', '2026-11-01'], ['昨天', '2026-10-31']] as const)('selects %s using the Shanghai business day', async (shortcut, expected) => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    expect(document.querySelector('td.ant-picker-cell-today')).toHaveAttribute('title', '2026-11-01');
    await userEvent.click(screen.getByText(shortcut, { exact: true }));
    expect(onChange).toHaveBeenLastCalledWith(expected);
  });

  it('selects the current Shanghai month with a shortcut', async () => {
    const onChange = vi.fn();
    render(<Field mode="month" value="2025-02" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByText('当前月份'));
    expect(onChange).toHaveBeenLastCalledWith('2026-11');
  });

  it('selects a real month cell and preserves the YYYY-MM contract', async () => {
    const onChange = vi.fn();
    render(<Field mode="month" value="2026-10" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByTitle('2026-02'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('2026-02'));
  });

  it('offers 24-hour/five-minute time choices and confirms a selected date and time', async () => {
    const onChange = vi.fn();
    render(<Field mode="datetime" value="2026-10-30T13:17" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByTitle('2026-10-28'));
    const columns = document.querySelectorAll<HTMLElement>('.ant-picker-time-panel-column');
    expect(columns).toHaveLength(2);
    expect(within(columns[0]!).getByText('23')).toBeVisible();
    expect(within(columns[1]!).getAllByRole('listitem').filter((item) => item.textContent)).toHaveLength(12);
    await userEvent.click(within(columns[0]!).getByText('09'));
    await userEvent.click(within(columns[1]!).getByText('35'));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /确.*定/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28T09:35');
  });

  it('keeps an existing non-step minute when changing only the calendar date', async () => {
    const onChange = vi.fn();
    render(<Field mode="datetime" value="2026-10-30T13:17" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByTitle('2026-10-28'));
    await userEvent.click(screen.getByRole('button', { name: /确.*定/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28T13:17');
  });

  it('uses Shanghai current time for datetime shortcuts', async () => {
    const onChange = vi.fn();
    render(<Field mode="datetime" onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.click(screen.getByText('今天', { exact: true }));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-01T00:07');
  });

  it('can clear an optional value with the clear control', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '清除日期' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('can clear an optional value using the keyboard', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" onChange={onChange} />);
    await enter('');
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('prevents clearing a required value, including by keyboard', async () => {
    const onChange = vi.fn();
    render(<Field value="2026-10-30" required onChange={onChange} />);
    expect(screen.queryByRole('button', { name: '清除日期' })).not.toBeInTheDocument();
    await enter('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('2026-10-30');
  });

  it('supports disabled/custom placeholder and controlled updates without emitting changes', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<BusinessDateField value="" disabled placeholder="按年月日输入" onChange={onChange} />);
    expect(screen.getByPlaceholderText('按年月日输入')).toBeDisabled();
    await userEvent.click(screen.getByRole('textbox'));
    expect(screen.queryByText('昨天')).not.toBeInTheDocument();
    rerender(<BusinessDateField value="2028-02-29" onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('2028-02-29'));
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
