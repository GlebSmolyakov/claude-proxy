import { describe, expect, it } from "vitest";

import { Channel, TIMEOUT } from "./channel.js";

describe("Channel", () => {
  it("keeps an item that arrives after a timed-out wait", async () => {
    const c = new Channel<number>();
    expect(await c.recvUntil(Date.now() + 5)).toBe(TIMEOUT);
    c.send(1);
    expect(await c.recv()).toBe(1);
  });

  it("drains buffered items before reporting the end", async () => {
    const c = new Channel<number>();
    c.send(1);
    c.send(2);
    c.close();
    c.send(3);
    const seen: number[] = [];
    for await (const item of c) {
      seen.push(item);
    }
    expect(seen).toEqual([1, 2]);
  });

  it("wakes a waiting reader on close", async () => {
    const c = new Channel<number>();
    const waiting = c.recv();
    c.close();
    expect(await waiting).toBeUndefined();
  });
});
