import type { PersistedAssistantEvent } from '../persistence/repository.js';

const MAX_QUEUED_EVENTS_PER_SUBSCRIBER = 256;

type Subscriber = {
  events: PersistedAssistantEvent[];
  waiter: (() => void) | undefined;
  closed: boolean;
  overflowed: boolean;
};

export type RunEventSubscription = {
  next(timeoutMs: number): Promise<PersistedAssistantEvent | undefined>;
  close(): void;
  readonly overflowed: boolean;
  readonly closed: boolean;
};

/** Process-local fan-out for events after they have been committed to the Agent store. */
export class RunEventHub {
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  subscribe(runId: string): RunEventSubscription {
    const subscriber: Subscriber = {
      events: [],
      waiter: undefined,
      closed: false,
      overflowed: false,
    };
    const subscribers = this.#subscribers.get(runId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(runId, subscribers);

    const close = () => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      subscriber.waiter?.();
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(runId);
    };

    return {
      get overflowed() {
        return subscriber.overflowed;
      },
      get closed() {
        return subscriber.closed;
      },
      close,
      async next(timeoutMs) {
        if (subscriber.events.length > 0) return subscriber.events.shift();
        if (subscriber.closed || subscriber.overflowed) return undefined;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            subscriber.waiter = undefined;
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          subscriber.waiter = finish;
        });
        return subscriber.events.shift();
      },
    };
  }

  publish(runId: string, event: PersistedAssistantEvent): void {
    const subscribers = this.#subscribers.get(runId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      if (subscriber.closed || subscriber.overflowed) continue;
      if (subscriber.events.length >= MAX_QUEUED_EVENTS_PER_SUBSCRIBER) {
        subscriber.overflowed = true;
        subscriber.waiter?.();
        continue;
      }
      subscriber.events.push(event);
      subscriber.waiter?.();
    }
  }

  closeAll(): void {
    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.closed = true;
        subscriber.waiter?.();
      }
    }
    this.#subscribers.clear();
  }

  get subscriberCount(): number {
    let count = 0;
    for (const subscribers of this.#subscribers.values()) count += subscribers.size;
    return count;
  }
}
