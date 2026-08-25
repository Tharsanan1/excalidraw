/**
 * Multi-page document support.
 *
 * Architecture:
 * - The ACTIVE page's elements live in the standard localStorage keys
 *   ("excalidraw" / "excalidraw-state"), so all existing flows (tab-sync,
 *   collab, reload restore) keep working unchanged.
 * - Page metadata (list, names, order, per-page viewport) is stored under
 *   STORAGE_KEYS.LOCAL_STORAGE_PAGES.
 * - Inactive pages' elements are stored one-per-key under the
 *   STORAGE_KEYS.LOCAL_STORAGE_PAGE_ELEMENTS_PREFIX prefix, so a large
 *   document doesn't need to re-serialize every page on each change.
 *
 * The store is framework-agnostic with a tiny pub/sub so React components can
 * bind via useSyncExternalStore.
 */

import { debounce } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import {
  SAVE_TO_LOCAL_STORAGE_TIMEOUT,
  STORAGE_KEYS,
} from "../app_constants";

const PAGES_SCHEMA_VERSION = 1;

export type PageViewport = {
  scrollX?: number;
  scrollY?: number;
  zoom?: number;
};

export type ExcalidrawPage = {
  id: string;
  name: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
} & PageViewport;

export type PersistedPagesState = {
  type: "excalidraw/pages";
  version: typeof PAGES_SCHEMA_VERSION;
  activePageId: string | null;
  pages: ExcalidrawPage[];
};

type PagesSnapshot = {
  pages: readonly ExcalidrawPage[];
  activePageId: string | null;
};

export const createPageId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `page-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

const isValidPage = (value: unknown): value is ExcalidrawPage => {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ExcalidrawPage).id === "string" &&
    (value as ExcalidrawPage).id.length > 0 &&
    typeof (value as ExcalidrawPage).name === "string" &&
    typeof (value as ExcalidrawPage).createdAt === "number" &&
    typeof (value as ExcalidrawPage).updatedAt === "number"
  );
};

/** viewport numbers can be anything finite (or absent for legacy data) */
const sanitizeViewport = ({ scrollX, scrollY, zoom }: PageViewport) => ({
  scrollX: Number.isFinite(scrollX) ? scrollX : 0,
  scrollY: Number.isFinite(scrollY) ? scrollY : 0,
  zoom: Number.isFinite(zoom) && (zoom as number) > 0 ? zoom : 1,
});

// -----------------------------------------------------------------------------
// in-memory state
// -----------------------------------------------------------------------------

let initialized = false;
let pages: ExcalidrawPage[] = [];
let activePageId: string | null = null;
let snapshot: PagesSnapshot = { pages: [], activePageId: null };

const listeners = new Set<() => void>();

const notifyListeners = () => {
  snapshot = { pages, activePageId };
  listeners.forEach((listener) => listener());
};

export const subscribeToPages = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** referentially stable between updates; safe for useSyncExternalStore */
export const getPagesSnapshot = (): PagesSnapshot => snapshot;

// -----------------------------------------------------------------------------
// persistence
// -----------------------------------------------------------------------------

let persistenceErrorListener: ((error: unknown) => void) | null = null;

/** register a callback (e.g. to surface a toast) for persistence failures */
export const setPersistenceErrorListener = (
  listener: ((error: unknown) => void) | null,
) => {
  persistenceErrorListener = listener;
};

const reportPersistenceError = (error: unknown) => {
  console.error("pageManager: failed to persist pages", error);
  try {
    persistenceErrorListener?.(error);
  } catch {}
};

const readPersistedState = (): PersistedPagesState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_PAGES);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (
      parsed?.type !== "excalidraw/pages" ||
      typeof parsed.version !== "number" ||
      !Array.isArray(parsed.pages)
    ) {
      return null;
    }
    // forward-compat: only accept versions we know how to read
    if (parsed.version > PAGES_SCHEMA_VERSION) {
      console.warn(
        `pageManager: persisted pages schema v${parsed.version} is newer than supported v${PAGES_SCHEMA_VERSION}, ignoring`,
      );
      return null;
    }
    const validPages = parsed.pages.filter(isValidPage);
    return {
      ...parsed,
      pages: validPages,
      activePageId:
        typeof parsed.activePageId === "string" &&
        validPages.some((p: ExcalidrawPage) => p.id === parsed.activePageId)
          ? parsed.activePageId
          : (validPages[0]?.id ?? null),
    };
  } catch (error) {
    console.warn("pageManager: failed to parse persisted pages", error);
    return null;
  }
};

const persistMeta = () => {
  const state: PersistedPagesState = {
    type: "excalidraw/pages",
    version: PAGES_SCHEMA_VERSION,
    activePageId,
    pages,
  };
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_PAGES,
      JSON.stringify(state),
    );
  } catch (error) {
    reportPersistenceError(error);
  }
};

const pageElementsKey = (pageId: string) =>
  `${STORAGE_KEYS.LOCAL_STORAGE_PAGE_ELEMENTS_PREFIX}${pageId}`;

export const saveInactivePageElements = (
  pageId: string,
  elements: readonly ExcalidrawElement[],
) => {
  try {
    localStorage.setItem(
      pageElementsKey(pageId),
      JSON.stringify(getNonDeletedElements(elements)),
    );
  } catch (error) {
    reportPersistenceError(error);
  }
};

export const loadPageElements = (
  pageId: string,
): readonly ExcalidrawElement[] | null => {
  try {
    const raw = localStorage.getItem(pageElementsKey(pageId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed as ExcalidrawElement[];
  } catch (error) {
    console.warn(`pageManager: failed to load elements of page ${pageId}`, error);
    return null;
  }
};

const removePageElements = (pageId: string) => {
  try {
    localStorage.removeItem(pageElementsKey(pageId));
  } catch (error) {
    console.warn(error);
  }
};

/** removes element keys for pages that no longer exist */
const cleanupOrphanedElementKeys = () => {
  try {
    const knownIds = new Set(pages.map((p) => p.id));
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key?.startsWith(STORAGE_KEYS.LOCAL_STORAGE_PAGE_ELEMENTS_PREFIX) &&
        !knownIds.has(key.slice(STORAGE_KEYS.LOCAL_STORAGE_PAGE_ELEMENTS_PREFIX.length))
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn(error);
  }
};

// -----------------------------------------------------------------------------
// init
// -----------------------------------------------------------------------------

/**
 * Idempotent. Restores pages from localStorage or seeds a single default page.
 * Must be called before any other API usage (except subscribe).
 */
export const initializePages = () => {
  if (initialized) {
    return;
  }
  initialized = true;

  const persisted = readPersistedState();
  if (persisted && persisted.pages.length > 0) {
    pages = persisted.pages;
    activePageId = persisted.activePageId;
  } else {
    const now = Date.now();
    const firstPage: ExcalidrawPage = {
      id: createPageId(),
      name: "Page 1",
      createdAt: now,
      updatedAt: now,
    };
    pages = [firstPage];
    activePageId = firstPage.id;
    persistMeta();
  }
  cleanupOrphanedElementKeys();
  window.addEventListener("storage", onStorageEvent);
  notifyListeners();
};

const onStorageEvent = (event: StorageEvent) => {
  if (event.key === STORAGE_KEYS.LOCAL_STORAGE_PAGES && event.newValue) {
    // another tab changed the page structure; adopt it
    const persisted = readPersistedState();
    if (persisted && persisted.pages.length > 0) {
      pages = persisted.pages;
      activePageId = persisted.activePageId ?? pages[0].id;
      notifyListeners();
    }
  }
};

// -----------------------------------------------------------------------------
// queries & mutations
// -----------------------------------------------------------------------------

export const getActivePageId = () => activePageId;

export const getPage = (pageId: string) => pages.find((p) => p.id === pageId);

/** updates stored viewport of a page without notifying subscribers
 * (viewport isn't rendered by the UI, so re-renders would be wasteful) */
export const updatePageViewport = (pageId: string, viewport: PageViewport) => {
  assertInitialized();
  const index = pages.findIndex((p) => p.id === pageId);
  if (index === -1) {
    return;
  }
  pages[index] = { ...pages[index], ...sanitizeViewport(viewport) };
  persistMeta();
};

const assertInitialized = () => {
  if (!initialized) {
    throw new Error("pageManager: not initialized, call initializePages() first");
  }
};

export const setActivePage = (pageId: string) => {
  assertInitialized();
  if (!pages.some((p) => p.id === pageId)) {
    throw new Error(`pageManager: unknown page ${pageId}`);
  }
  activePageId = pageId;
  persistMeta();
  notifyListeners();
};

export const addPage = (name?: string): ExcalidrawPage => {
  assertInitialized();
  const now = Date.now();
  const page: ExcalidrawPage = {
    id: createPageId(),
    name: name ?? `Page ${pages.length + 1}`,
    createdAt: now,
    updatedAt: now,
  };
  pages = [...pages, page];
  persistMeta();
  notifyListeners();
  return page;
};

export const renamePage = (pageId: string, name: string) => {
  assertInitialized();
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  pages = pages.map((p) =>
    p.id === pageId ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
  );
  persistMeta();
  notifyListeners();
};

export const duplicatePage = (
  pageId: string,
  /** required when duplicating the active page (its elements aren't yet
   * persisted under the page-specific key) */
  activeElements?: readonly ExcalidrawElement[],
): ExcalidrawPage | null => {
  assertInitialized();
  const index = pages.findIndex((p) => p.id === pageId);
  if (index === -1) {
    return null;
  }
  const source = pages[index];
  const now = Date.now();
  const copy: ExcalidrawPage = {
    id: createPageId(),
    name: `${source.name} copy`,
    createdAt: now,
    updatedAt: now,
  };
  const sourceElements =
    pageId === activePageId ? activeElements : loadPageElements(pageId);
  if (sourceElements && sourceElements.length > 0) {
    // deep-clone so edits to the copy never mutate shared element ids/objects
    const cloned = JSON.parse(
      JSON.stringify(getNonDeletedElements(sourceElements)),
    ) as ExcalidrawElement[];
    saveInactivePageElements(copy.id, cloned);
  }
  pages = [
    ...pages.slice(0, index + 1),
    copy,
    ...pages.slice(index + 1),
  ];
  persistMeta();
  notifyListeners();
  return copy;
};

/**
 * Deletes a page. Returns the id of the page that should become active
 * (only differs from current active when the active page was deleted).
 */
export const deletePage = (
  pageId: string,
): { nextActivePageId: string | null; deletedWasActive: boolean } => {
  assertInitialized();
  if (pages.length <= 1) {
    return { nextActivePageId: activePageId, deletedWasActive: false };
  }
  const index = pages.findIndex((p) => p.id === pageId);
  if (index === -1) {
    return { nextActivePageId: activePageId, deletedWasActive: false };
  }

  pages = pages.filter((p) => p.id !== pageId);
  removePageElements(pageId);

  let deletedWasActive = false;
  if (activePageId === pageId) {
    deletedWasActive = true;
    activePageId = pages[Math.max(0, index - 1)].id;
  }
  persistMeta();
  notifyListeners();
  return { nextActivePageId: activePageId, deletedWasActive };
};

export const movePage = (pageId: string, direction: "left" | "right") => {
  assertInitialized();
  const index = pages.findIndex((p) => p.id === pageId);
  if (index === -1) {
    return;
  }
  const targetIndex = direction === "left" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= pages.length) {
    return;
  }
  const reordered = [...pages];
  [reordered[index], reordered[targetIndex]] = [
    reordered[targetIndex],
    reordered[index],
  ];
  pages = reordered;
  persistMeta();
  notifyListeners();
};

/**
 * Replaces the whole document state with an imported one (used by
 * "open multi-page document"). Wipes all previously persisted page element
 * keys, stores the imported per-page elements and activates the given page.
 */
export const resetWithImportedPages = (
  newPages: ExcalidrawPage[],
  newActivePageId: string,
  elementsByPage: Record<string, readonly ExcalidrawElement[]>,
) => {
  assertInitialized();
  if (!newPages.some((p) => p.id === newActivePageId)) {
    throw new Error("pageManager: activePageId not present in pages");
  }
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEYS.LOCAL_STORAGE_PAGE_ELEMENTS_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    console.warn(error);
  }

  for (const [pageId, elements] of Object.entries(elementsByPage)) {
    if (pageId !== newActivePageId && elements.length > 0) {
      saveInactivePageElements(pageId, elements);
    }
  }
  // the active page's elements are persisted under the standard
  // LOCAL_STORAGE_ELEMENTS key by LocalData once the scene updates

  pages = newPages;
  activePageId = newActivePageId;
  persistMeta();
  notifyListeners();
};

// -----------------------------------------------------------------------------
// active-page change recording (hot path — keep cheap & debounced)
// -----------------------------------------------------------------------------

const debouncedRecordChange = debounce(() => {
  pages = pages.map((p) =>
    p.id === activePageId ? { ...p, updatedAt: Date.now() } : p,
  );
  persistMeta();
}, SAVE_TO_LOCAL_STORAGE_TIMEOUT);

/**
 * Records that the active page's content/viewport changed. Elements themselves
 * are persisted by LocalData under the standard key; here we keep the page's
 * viewport + updatedAt metadata fresh (debounced persistence).
 */
export const recordActivePageChange = (appState: AppState) => {
  if (!initialized || !activePageId) {
    return;
  }
  if (document.hidden) {
    // mirror LocalData semantics: don't write while tab is hidden
    return;
  }
  const index = pages.findIndex((p) => p.id === activePageId);
  if (index === -1) {
    return;
  }
  const { scrollX, scrollY, zoom } = sanitizeViewport({
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom?.value,
  });
  pages[index] = { ...pages[index], scrollX, scrollY, zoom };
  debouncedRecordChange();
};

/** force-flush pending metadata writes (e.g. on beforeunload) */
export const flushPendingWrites = () => {
  debouncedRecordChange.flush();
};
