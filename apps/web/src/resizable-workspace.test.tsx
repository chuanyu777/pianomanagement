import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableWorkspace } from './resizable-workspace.js';

let availableWidth = 942;
let notifyResize: ResizeObserverCallback;

function resize(viewport: number, available: number) {
  availableWidth = available;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport });
  act(() => {
    fireEvent(window, new Event('resize'));
    notifyResize([], {} as ResizeObserver);
  });
}

function StatefulPane({ label }: { label: string }) {
  const [value, setValue] = useState('');
  return <section><input aria-label={label} onChange={(event) => setValue(event.target.value)} value={value} /></section>;
}

function workspace() {
  return render(<ResizableWorkspace className="business-page-schedule"><StatefulPane label="助手草稿" /><StatefulPane label="业务筛选" /></ResizableWorkspace>);
}

function separator() {
  return screen.getByRole('separator', { name: '调整 AI 助手宽度' });
}

beforeEach(() => {
  availableWidth = 942;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1126 });
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: availableWidth, left: 184, right: 184 + availableWidth, top: 0, bottom: 800, height: 800, x: 184, y: 0, toJSON() {} }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ResizableWorkspace', () => {
  it('starts with a readable AI pane at common desktop widths and grows with the viewport', () => {
    const { container } = workspace();
    expect(separator()).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator()).toHaveAttribute('aria-valuenow', '360');
    expect(container.firstElementChild).toHaveStyle({ '--workspace-assistant-width': '360px' });
    resize(1440, 1256);
    expect(separator()).toHaveAttribute('aria-valuenow', '440');
    resize(1920, 1736);
    expect(separator()).toHaveAttribute('aria-valuenow', '520');
  });

  it('supports focused keyboard resizing and clamps both ends while reserving business space', () => {
    workspace();
    const handle = separator();
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '380');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(handle, { key: 'End' });
    // 942px workspace leaves 400px for business content and 12px for the handle.
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    expect(handle).toHaveFocus();
  });

  it('reclamps on container resize and restores the saved preference when space returns', () => {
    const view = workspace();
    fireEvent.keyDown(separator(), { key: 'End' });
    resize(1126, 820);
    expect(separator()).toHaveAttribute('aria-valuenow', '408');
    resize(1000, 716);
    expect(separator()).toHaveAttribute('aria-valuenow', '304');
    resize(1440, 1256);
    expect(separator()).toHaveAttribute('aria-valuenow', '520');
    view.unmount();
    workspace();
    expect(separator()).toHaveAttribute('aria-valuenow', '520');
  });

  it('uses pointer capture, ignores other pointers, and stops dragging when capture is lost', () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    });
    workspace();
    const handle = separator();
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(handle, { setPointerCapture: capture, releasePointerCapture: release, hasPointerCapture: () => true });
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 544, button: 0 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(handle, { pointerId: 8, clientX: 650 });
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 624 });
    expect(handle).toHaveAttribute('aria-valuenow', '440');
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 2000 });
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 2000 });
    expect(release).toHaveBeenCalledWith(7);
    fireEvent.pointerDown(handle, { pointerId: 9, clientX: 704, button: 0 });
    fireEvent.lostPointerCapture(handle, { pointerId: 9 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: 300 });
    expect(handle).toHaveAttribute('aria-valuenow', '520');
  });

  it('keeps both panes mounted and disables the divider below the desktop breakpoint', () => {
    workspace();
    const draft = screen.getByRole('textbox', { name: '助手草稿' });
    const filter = screen.getByRole('textbox', { name: '业务筛选' });
    fireEvent.change(draft, { target: { value: '明天排课' } });
    fireEvent.change(filter, { target: { value: '小明' } });
    fireEvent.keyDown(separator(), { key: 'End' });
    resize(899, 899);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { hidden: true })).toHaveAttribute('tabindex', '-1');
    resize(1440, 1256);
    expect(screen.getByRole('textbox', { name: '助手草稿' })).toBe(draft);
    expect(draft).toHaveValue('明天排课');
    expect(filter).toHaveValue('小明');
    expect(separator()).toHaveAttribute('aria-valuenow', '520');
  });

  it('continues resizing when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    workspace();
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(separator()).toHaveAttribute('aria-valuenow', '380');
  });
});
