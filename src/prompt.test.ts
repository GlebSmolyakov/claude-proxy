import { describe, expect, it } from "vitest";

import { promptContent } from "./prompt.js";

describe("promptContent", () => {
  it("passes text and images and drops audio", () => {
    expect(
      promptContent([
        { type: "text", text: "what is this?" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "image", data: "", mimeType: "image/png", uri: "https://x/y.png" },
        { type: "audio", data: "QQ==", mimeType: "audio/wav" },
      ]),
    ).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
  });

  it("mentions files and adds embedded text as context at the end", () => {
    expect(
      promptContent([
        { type: "text", text: "compare" },
        { type: "resource_link", uri: "file:///repo/a.ts", name: "a.ts" },
        { type: "resource", resource: { uri: "file:///repo/b.ts", text: "export {}" } },
        { type: "resource", resource: { uri: "file:///repo/c.bin", blob: "AA==" } },
      ]),
    ).toEqual([
      { type: "text", text: "compare" },
      { type: "text", text: "[@a.ts](file:///repo/a.ts)" },
      { type: "text", text: "[@b.ts](file:///repo/b.ts)" },
      { type: "text", text: '\n<context ref="file:///repo/b.ts">\nexport {}\n</context>' },
    ]);
  });
});
