import { describe, expect, it } from 'vitest';
import { LessonsService } from './lessons.service.js';

describe('historical lesson consumption correction contract', () => {
  it('exposes a dedicated Preview projection instead of a payment or plain reversal', () => {
    const service = new LessonsService({} as never, {} as never);
    expect(service.previewCompletionCorrection).toBeTypeOf('function');
  });
});
