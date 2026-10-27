import { AsyncLocalStorage } from 'node:async_hooks';

const businessTime = new AsyncLocalStorage<Date>();

export function businessNow(): Date {
  const configured = businessTime.getStore();
  return configured ? new Date(configured.getTime()) : new Date();
}

export function withBusinessTime<T>(date: Date, callback: () => T): T {
  return businessTime.run(new Date(date.getTime()), callback);
}
