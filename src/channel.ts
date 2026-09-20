// An unbounded queue with one consumer: a turn pushes its events in the
// background, and the route reads them at its own pace.

/** What `recvUntil` returns when the deadline comes first. */
export const TIMEOUT = Symbol("timeout");

export class Channel<T> {
  private items: T[] = [];
  private waiter?: (item: T | undefined) => void;
  private closed = false;

  send(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  /** No more items will come; a waiting `recv` gets `undefined`. */
  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }

  /** The next item, or `undefined` once the channel is closed and drained. */
  recv(): Promise<T | undefined> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift());
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Like `recv`, but gives up at `deadline` (a `Date.now()` value). */
  recvUntil(deadline: number): Promise<T | undefined | typeof TIMEOUT> {
    if (this.items.length > 0 || this.closed) {
      return this.recv();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiter = undefined;
          resolve(TIMEOUT);
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = await this.recv();
      if (item === undefined) {
        return;
      }
      yield item;
    }
  }
}
