// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResizableRail, type ResizableRail } from "./useResizableRail";

const KEY = "test.rail.width";

// 仓里没有 @testing-library，既有测试都是自己 createRoot，这里照同一套来。
let latest: ResizableRail;
function Probe(props: Parameters<typeof useResizableRail>[0]) {
  latest = useResizableRail(props);
  return null;
}

function pointer(clientX: number) {
  return { clientX, preventDefault() {}, pointerId: 1, currentTarget: { setPointerCapture() {} } } as never;
}

describe("useResizableRail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  });

  async function mount(props: Parameters<typeof useResizableRail>[0]) {
    await act(async () => root.render(<Probe {...props} />));
  }

  it("hands the width back as a css variable, not an inline width", async () => {
    await mount({ storageKey: KEY });
    // 手机端 rail 是整宽的，宽度只能在 sm 以上生效，所以必须走变量。
    expect(latest.railStyle).toEqual({ "--rail-w": "288px" });
    expect("width" in latest.railStyle).toBe(false);
  });

  it("tracks the pointer while dragging and persists on release", async () => {
    await mount({ storageKey: KEY });
    await act(async () => latest.handleProps.onPointerDown(pointer(100)));
    await act(async () => latest.handleProps.onPointerMove(pointer(160)));
    expect(latest.width).toBe(348);
    expect(localStorage.getItem(KEY)).toBeNull();
    await act(async () => latest.handleProps.onPointerUp());
    expect(localStorage.getItem(KEY)).toBe("348");
  });

  it("clamps to the min and max instead of letting the rail vanish", async () => {
    await mount({ storageKey: KEY, min: 200, max: 640 });
    await act(async () => latest.handleProps.onPointerDown(pointer(500)));
    await act(async () => latest.handleProps.onPointerMove(pointer(0)));
    expect(latest.width).toBe(200);
    await act(async () => latest.handleProps.onPointerMove(pointer(5000)));
    expect(latest.width).toBe(640);
  });

  it("restores the stored width on mount", async () => {
    localStorage.setItem(KEY, "410");
    await mount({ storageKey: KEY });
    expect(latest.width).toBe(410);
  });

  it("moves on arrow keys so the rail is reachable without a mouse", async () => {
    await mount({ storageKey: KEY });
    await act(async () => latest.handleProps.onKeyDown({ key: "ArrowRight", preventDefault() {} } as never));
    expect(latest.width).toBe(304);
    expect(localStorage.getItem(KEY)).toBe("304");
  });
});
