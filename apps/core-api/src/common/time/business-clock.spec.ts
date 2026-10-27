import { describe, expect, it } from 'vitest';
import { businessNow, withBusinessTime } from './business-clock.js';

describe('business clock', () => {
  it('returns the real system time by default', () => {
    const before = Date.now();
    const value = businessNow();

    expect(value.getTime()).toBeGreaterThanOrEqual(before);
    expect(value.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns a clone and keeps the configured time scoped to async context', async () => {
    const configured = new Date('2026-10-21T00:00:00.000Z');

    await withBusinessTime(configured, async () => {
      const value = businessNow();
      value.setUTCDate(value.getUTCDate() + 1);

      expect(businessNow()).toEqual(configured);
    });

    expect(businessNow()).not.toEqual(configured);
  });

  it('isolates concurrent async contexts', async () => {
    const first = new Date('2026-01-01T00:00:00.000Z');
    const second = new Date('2026-02-01T00:00:00.000Z');

    const [firstValue, secondValue] = await Promise.all([
      withBusinessTime(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return businessNow();
      }),
      withBusinessTime(second, async () => {
        await Promise.resolve();
        return businessNow();
      }),
    ]);

    expect(firstValue).toEqual(first);
    expect(secondValue).toEqual(second);
  });

  it('does not freeze Date.now while a business time is configured', async () => {
    const before = Date.now();

    await withBusinessTime(new Date('2000-01-01T00:00:00.000Z'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(Date.now()).toBeGreaterThanOrEqual(before);
    });
  });
});
