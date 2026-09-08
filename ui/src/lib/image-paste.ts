import { createRootEditorSubscription$, imageUploadHandler$, insertImage$, realmPlugin } from "@mdxeditor/editor";
import { COMMAND_PRIORITY_CRITICAL, PASTE_COMMAND } from "lexical";

function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * Claims a paste when the clipboard carries at least one image file.
 *
 * The bundled @mdxeditor image plugin only claims a paste when *every*
 * clipboard item is an image (`isMixedPayload` bails otherwise), and both
 * screenshots and browser image copies ship a text/html or text/plain sibling,
 * so in practice it never fires. Sibling text items describe the same image,
 * so the paste is consumed whole rather than re-dispatched as text.
 */
export function createImagePasteHandler(deps: {
  hasUploadHandler: () => boolean;
  insertImage: (file: File) => void;
}): (event: ClipboardEvent) => boolean {
  return (event) => {
    if (!deps.hasUploadHandler()) return false;
    const files = imageFilesFrom(event.clipboardData);
    if (files.length === 0) return false;
    event.preventDefault();
    for (const file of files) deps.insertImage(file);
    return true;
  };
}

export const imagePastePlugin = realmPlugin({
  init(realm) {
    const handle = createImagePasteHandler({
      hasUploadHandler: () => Boolean(realm.getValue(imageUploadHandler$)),
      insertImage: (file) => {
        realm.pub(insertImage$, { file, altText: "" });
      },
    });
    realm.pub(createRootEditorSubscription$, [
      (editor) =>
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => (event instanceof ClipboardEvent ? handle(event) : false),
          COMMAND_PRIORITY_CRITICAL,
        ),
    ]);
  },
});
