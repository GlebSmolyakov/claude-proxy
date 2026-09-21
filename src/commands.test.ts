import { describe, expect, it } from "vitest";

import { hostCommand } from "./commands.js";

describe("telling this host's own commands from anything else", () => {
  it("takes the name and what follows it", () => {
    expect(hostCommand([{ type: "text", text: "/rewind" }])?.command.name).toBe("rewind");
    expect(hostCommand([{ type: "text", text: "/rewind 3" }])).toMatchObject({
      command: { name: "rewind" },
      args: "3",
    });
  });

  it("leaves the CLI's own commands and ordinary text alone", () => {
    expect(hostCommand([{ type: "text", text: "/compact" }])).toBeNull();
    expect(hostCommand([{ type: "text", text: "rewind the changes" }])).toBeNull();
    // A word that starts with the name is not the name.
    expect(hostCommand([{ type: "text", text: "/rewinder" }])).toBeNull();
    expect(hostCommand([])).toBeNull();
  });
});
