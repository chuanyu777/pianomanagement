import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './resizable-workspace.css';

const WIDTH_PREFERENCE_KEY = 'pianomanager.business-assistant-width.v1';
const DIVIDER_WIDTH = 12;
const BUSINESS_MIN_WIDTH = 400;

function readPreferredWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(WIDTH_PREFERENCE_KEY);
    if (!stored) return null;
    const width = Number(stored);
    return Number.isFinite(width) && width >= 280 && width <= 520 ? width : null;
  } catch {
    return null;
  }
}

/** Keeps both panes mounted across resizing and the stacked mobile layout. */
export function ResizableWorkspace({ children, className = '' }: { children: [ReactNode, ReactNode]; className?: string }) {
  const rootRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(readPreferredWidth);
  const [size, setSize] = useState(() => ({ viewport: window.innerWidth, available: window.innerWidth }));
  const [dragging, setDragging] = useState(false);
  const desktop = size.viewport > 900;
  // Near the stacking breakpoint the assistant yields space to the business pane.
  // Exceptionally constrained containers scroll the business content internally.
  const maximum = Math.max(280, Math.min(520, size.available - DIVIDER_WIDTH - BUSINESS_MIN_WIDTH));
  const minimum = Math.min(360, maximum);
  const clamp = (width: number) => Math.round(Math.min(maximum, Math.max(minimum, width)));
  const assistantWidth = clamp(preferredWidth ?? Math.round(size.viewport / 1440 * 440));

  useEffect(() => {
    const measure = () => {
      setSize({ viewport: window.innerWidth, available: rootRef.current?.getBoundingClientRect().width || window.innerWidth });
      if (window.innerWidth <= 900) {
        dragRef.current = null;
        setDragging(false);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (preferredWidth === null) return;
    try {
      window.localStorage.setItem(WIDTH_PREFERENCE_KEY, String(preferredWidth));
    } catch {
      // A blocked browser preference store must not disable resizing.
    }
  }, [preferredWidth]);

  return <section className={`business-page resizable-workspace ${className}${dragging ? ' is-resizing' : ''}`} ref={rootRef} style={{ '--workspace-assistant-width': `${assistantWidth}px` } as CSSProperties}>
    {children[0]}
    <div
      aria-label="调整 AI 助手宽度"
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={assistantWidth}
      aria-valuetext={`${assistantWidth} 像素`}
      className="resizable-workspace-divider"
      hidden={!desktop}
      onKeyDown={(event) => {
        if (!desktop) return;
        const width = event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'ArrowLeft' ? assistantWidth - 20 : event.key === 'ArrowRight' ? assistantWidth + 20 : null;
        if (width === null) return;
        event.preventDefault();
        setPreferredWidth(clamp(width));
      }}
      onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerDown={(event) => {
        if (!desktop || event.button !== 0 || dragRef.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: assistantWidth };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!desktop || !drag || drag.pointerId !== event.pointerId) return;
        setPreferredWidth(clamp(drag.startWidth + event.clientX - drag.startX));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setPreferredWidth(clamp(drag.startWidth + event.clientX - drag.startX));
        dragRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      role="separator"
      tabIndex={desktop ? 0 : -1}
    />
    {children[1]}
  </section>;
}
