// InfoTip renders children inline and keeps the tooltip bubble hidden until
// the 240ms hover delay elapses — the repo's runner is node-only (no jsdom),
// so this asserts the static-markup contract: trigger visible, intro hidden.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoTip } from "./InfoTip";

describe("InfoTip", () => {
  it("renders the trigger children", () => {
    const html = renderToStaticMarkup(
      createElement(
        InfoTip,
        { title: "记忆", description: "做梦沉淀出的长期记忆。" },
        createElement("button", null, "open"),
      ),
    );
    expect(html).toContain("open");
  });

  it("keeps the tooltip hidden before any hover (no role=tooltip, no intro text)", () => {
    const html = renderToStaticMarkup(
      createElement(
        InfoTip,
        { title: "记忆", description: "做梦沉淀出的长期记忆。" },
        createElement("button", null, "open"),
      ),
    );
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("做梦沉淀出的长期记忆。");
  });

  it("passes className onto the trigger wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(
        InfoTip,
        { title: "t", description: "d", className: "flex w-full" },
        createElement("span", null, "x"),
      ),
    );
    expect(html).toContain("flex w-full");
  });
});
