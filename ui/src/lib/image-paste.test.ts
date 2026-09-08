import { describe, expect, it, vi } from "vitest";
import { createImagePasteHandler } from "./image-paste";

type FakeItem = { type: string; file?: File };

function pngFile(name = "shot.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function clipboardEvent(items: FakeItem[] | null) {
  const preventDefault = vi.fn();
  const clipboardData =
    items === null
      ? null
      : {
          items: items.map((item) => ({
            type: item.type,
            getAsFile: () => item.file ?? null,
          })),
        };
  return {
    event: { clipboardData, preventDefault } as unknown as ClipboardEvent,
    preventDefault,
  };
}

function handlerWith(hasUploadHandler = true) {
  const insertImage = vi.fn();
  return { insertImage, handle: createImagePasteHandler({ hasUploadHandler: () => hasUploadHandler, insertImage }) };
}

describe("createImagePasteHandler", () => {
  it("claims a screenshot paste (image only)", () => {
    const file = pngFile();
    const { insertImage, handle } = handlerWith();
    const { event, preventDefault } = clipboardEvent([{ type: "image/png", file }]);

    expect(handle(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(insertImage).toHaveBeenCalledExactlyOnceWith(file);
  });

  it("claims a browser image copy (image + text/html sibling)", () => {
    const file = pngFile();
    const { insertImage, handle } = handlerWith();
    const { event, preventDefault } = clipboardEvent([
      { type: "text/html", file: undefined },
      { type: "image/png", file },
    ]);

    expect(handle(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(insertImage).toHaveBeenCalledExactlyOnceWith(file);
  });

  it("uploads every image of a mixed payload exactly once", () => {
    const first = pngFile("a.png");
    const second = pngFile("b.png");
    const { insertImage, handle } = handlerWith();
    const { event } = clipboardEvent([
      { type: "text/plain" },
      { type: "image/png", file: first },
      { type: "text/html" },
      { type: "image/png", file: second },
    ]);

    expect(handle(event)).toBe(true);
    expect(insertImage.mock.calls).toEqual([[first], [second]]);
  });

  it("leaves a plain-text paste to the default handlers", () => {
    const { insertImage, handle } = handlerWith();
    const { event, preventDefault } = clipboardEvent([{ type: "text/plain" }, { type: "text/html" }]);

    expect(handle(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(insertImage).not.toHaveBeenCalled();
  });

  it("leaves an empty clipboard alone", () => {
    const { insertImage, handle } = handlerWith();
    const empty = clipboardEvent([]);
    const missing = clipboardEvent(null);

    expect(handle(empty.event)).toBe(false);
    expect(handle(missing.event)).toBe(false);
    expect(empty.preventDefault).not.toHaveBeenCalled();
    expect(missing.preventDefault).not.toHaveBeenCalled();
    expect(insertImage).not.toHaveBeenCalled();
  });

  it("does nothing when no upload handler is configured", () => {
    const { insertImage, handle } = handlerWith(false);
    const { event, preventDefault } = clipboardEvent([{ type: "image/png", file: pngFile() }]);

    expect(handle(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(insertImage).not.toHaveBeenCalled();
  });
});
