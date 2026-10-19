import { describe, expect, it } from 'vitest';
import { parseStructuredActionIntent } from './business-query-graph.js';

describe('parseStructuredActionIntent', () => {
  it('extracts the student and business date from direct lesson completion reversal requests', () => {
    expect(parseStructuredActionIntent('撤销AI学生1792224591416在2026-10-18的课消')).toEqual({
      actionIntent: {
        kind: 'lesson.complete.reversal',
        studentName: 'AI学生1792224591416',
        date: '2026-10-18',
      },
    });
  });
});
