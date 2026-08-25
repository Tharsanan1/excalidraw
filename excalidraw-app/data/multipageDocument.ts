import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { t } from "@excalidraw/excalidraw/i18n";
import { getNonDeletedElements, isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import {
  getPagesSnapshot,
  loadPageElements,
  resetWithImportedPages,
} from "./pageManager";

/**
 * Multi-page document format.
 *
 * The outer shape matches the standard .excalidraw file (elements/appState of
 * the active page), so older readers simply ignore the extra `pages` field —
 * fully backward & forward compatible.
 */
export type MultiPageDocument = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<FileId, BinaryFileData> | undefined;
  pages: {
    activePageId: string;
    list: {
      id: string;
      name: string;
      createdAt: number;
      updatedAt: number;
      scrollX?: number;
      scrollY?: number;
      zoom?: number;
    }[];
    elementsByPage: Record<string, readonly ExcalidrawElement[]>;
  };
};

const isMultiPageDocument = (
  data: unknown,
): data is MultiPageDocument => {
  return (
    !!data &&
    typeof data === "object" &&
    (data as MultiPageDocument).type === "excalidraw" &&
    !!(data as MultiPageDocument).pages &&
    Array.isArray((data as MultiPageDocument).pages?.list) &&
    typeof (data as MultiPageDocument).pages?.activePageId === "string"
  );
};

export const exportMultiPageDocument = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): MultiPageDocument => {
  const { pages, activePageId } = getPagesSnapshot();
  const activeElements =
    excalidrawAPI.getSceneElementsIncludingDeleted();
  const appState = excalidrawAPI.getAppState();
  const allFiles = excalidrawAPI.getFiles();

  const elementsByPage: Record<string, readonly ExcalidrawElement[]> = {};
  const referencedFileIds = new Set<FileId>();

  for (const page of pages) {
    if (page.id === activePageId || !activePageId) {
      continue;
    }
    const elements = loadPageElements(page.id) ?? [];
    elementsByPage[page.id] = getNonDeletedElements(elements);
    for (const element of elements) {
      if (isInitializedImageElement(element)) {
        referencedFileIds.add(element.fileId);
      }
    }
  }

  // serialize the active page with the standard serializer so the base file
  // stays a valid .excalidraw document
  const serializedActive = JSON.parse(
    serializeAsJSON(activeElements, appState, allFiles, "local"),
  );

  const doc: MultiPageDocument = {
    ...serializedActive,
    // serializeAsJSON embeds the passed type ("local"); the canonical
    // document type must be "excalidraw" for the import validator
    type: "excalidraw",
    version: 2,
    pages: {
      activePageId: activePageId!,
      list: pages,
      elementsByPage,
    },
  };

  return doc;
};

export const downloadMultiPageDocument = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const doc = exportMultiPageDocument(excalidrawAPI);
  const name = `${excalidrawAPI.getName() || "Untitled-2026"}-multipage.excalidraw`;
  const blob = new Blob([JSON.stringify(doc, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

export const importMultiPageDocument = async (
  file: File,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    window.alert(t("alerts.multipageImportFailed") as string);
    return;
  }
  if (!isMultiPageDocument(data)) {
    window.alert(t("alerts.notAMultipageDocument") as string);
    return;
  }

  const { list, activePageId, elementsByPage } = data.pages;

  // merge imported binary files into the global file store so images render
  if (data.files) {
    excalidrawAPI.addFiles(Object.values(data.files));
  }

  resetWithImportedPages(list, activePageId, elementsByPage);

  // show the imported active page
  const activeRaw = elementsByPage[activePageId] ?? data.elements ?? [];
  excalidrawAPI.updateScene({
    elements: restoreElements(activeRaw, null, { repairBindings: true }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  excalidrawAPI.history.clear();
};

export const openMultiPageDocumentPicker = (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".excalidraw,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) {
      await importMultiPageDocument(file, excalidrawAPI);
    }
  };
  input.click();
};
