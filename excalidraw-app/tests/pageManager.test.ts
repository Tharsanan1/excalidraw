import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  addPage,
  deletePage,
  duplicatePage,
  getPagesSnapshot,
  initializePages,
  movePage,
  renamePage,
  resetWithImportedPages,
  saveInactivePageElements,
  setActivePage,
  loadPageElements,
} from "../data/pageManager";

const createElement = (id: string): any => ({
  id,
  type: "rectangle",
  isDeleted: false,
});

describe("pageManager", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  // re-import after module reset so each test starts from a fresh singleton
  const fresh = async () => {
    const mod = await import("../data/pageManager");
    return mod;
  };

  it("seeds a single default page when storage is empty", async () => {
    const pm = await fresh();
    pm.initializePages();
    const { pages, activePageId } = pm.getPagesSnapshot();
    expect(pages).toHaveLength(1);
    expect(activePageId).toBe(pages[0].id);
    expect(pages[0].name).toBe("Page 1");
  });

  it("is idempotent across initialize calls", async () => {
    const pm = await fresh();
    pm.initializePages();
    const before = pm.getPagesSnapshot();
    pm.initializePages();
    expect(pm.getPagesSnapshot()).toEqual(before);
  });

  it("restores pages from localStorage", async () => {
    localStorage.setItem(
      "excalidraw-pages",
      JSON.stringify({
        type: "excalidraw/pages",
        version: 1,
        activePageId: "p2",
        pages: [
          { id: "p1", name: "A", createdAt: 1, updatedAt: 1 },
          { id: "p2", name: "B", createdAt: 2, updatedAt: 2 },
        ],
      }),
    );
    const pm = await fresh();
    pm.initializePages();
    const { pages, activePageId } = pm.getPagesSnapshot();
    expect(pages.map((p) => p.name)).toEqual(["A", "B"]);
    expect(activePageId).toBe("p2");
  });

  it("falls back to first page if persisted activePageId is invalid", async () => {
    localStorage.setItem(
      "excalidraw-pages",
      JSON.stringify({
        type: "excalidraw/pages",
        version: 1,
        activePageId: "missing",
        pages: [{ id: "p1", name: "A", createdAt: 1, updatedAt: 1 }],
      }),
    );
    const pm = await fresh();
    pm.initializePages();
    expect(pm.getActivePageId()).toBe("p1");
  });

  it("rejects newer schema versions instead of crashing", async () => {
    localStorage.setItem(
      "excalidraw-pages",
      JSON.stringify({ type: "excalidraw/pages", version: 999, pages: [] }),
    );
    const pm = await fresh();
    pm.initializePages();
    expect(pm.getPagesSnapshot().pages).toHaveLength(1); // seeded default
  });

  it("ignores corrupted entries", async () => {
    localStorage.setItem("excalidraw-pages", "{not json");
    const pm = await fresh();
    pm.initializePages();
    expect(pm.getPagesSnapshot().pages).toHaveLength(1);
  });

  it("adds, renames and switches pages", async () => {
    const pm = await fresh();
    pm.initializePages();
    const page = pm.addPage();
    expect(pm.getPagesSnapshot().pages).toHaveLength(2);

    pm.renamePage(page.id, "  Draft  ");
    expect(
      pm.getPagesSnapshot().pages.find((p) => p.id === page.id)?.name,
    ).toBe("Draft");

    pm.setActivePage(page.id);
    expect(pm.getActivePageId()).toBe(page.id);

    // whitespace-only names are ignored
    pm.renamePage(page.id, "   ");
    expect(
      pm.getPagesSnapshot().pages.find((p) => p.id === page.id)?.name,
    ).toBe("Draft");
  });

  it("refuses to delete the last page and never leaves an empty list", async () => {
    const pm = await fresh();
    pm.initializePages();
    const only = pm.getPagesSnapshot().pages[0];
    const result = pm.deletePage(only.id);
    expect(result.deletedWasActive).toBe(false);
    expect(pm.getPagesSnapshot().pages).toHaveLength(1);
  });

  it("deletes active page and activates the neighbor", async () => {
    const pm = await fresh();
    pm.initializePages();
    const second = pm.addPage(); // [p1, p2], active = p1
    pm.setActivePage(second.id); // active = p2
    const result = pm.deletePage(second.id);
    expect(result.deletedWasActive).toBe(true);
    expect(pm.getPagesSnapshot().pages.map((p) => p.id)).not.toContain(
      second.id,
    );
    expect(pm.getActivePageId()).toBe(
      pm.getPagesSnapshot().pages[0].id,
    );
  });

  it("duplicates a page including its elements", async () => {
    const pm = await fresh();
    pm.initializePages();
    const source = pm.getPagesSnapshot().pages[0];
    // duplicating the *active* page requires passing its live elements
    const copy = pm.duplicatePage(source.id, [
      createElement("e1"),
      { ...createElement("e2"), isDeleted: true },
    ])!;
    expect(copy.name).toBe("Page 1 copy");
    const copiedElements = pm.loadPageElements(copy.id)!;
    expect(copiedElements).toHaveLength(1); // deleted stripped
    expect(copiedElements[0].id).toBe("e1");

    // duplicating an *inactive* page reads its persisted elements
    saveInactivePageElements(copy.id, [createElement("e3")]);
    const copyOfCopy = pm.duplicatePage(copy.id)!;
    expect(pm.loadPageElements(copyOfCopy.id)![0].id).toBe("e3");
  });

  it("moves pages left/right", async () => {
    const pm = await fresh();
    pm.initializePages();
    const second = pm.addPage();
    pm.movePage(second.id, "left");
    expect(pm.getPagesSnapshot().pages[0].id).toBe(second.id);
    pm.movePage(second.id, "left"); // already first — no-op
    expect(pm.getPagesSnapshot().pages[0].id).toBe(second.id);
  });

  it("resets state on document import and wipes old element keys", async () => {
    const pm = await fresh();
    pm.initializePages();
    const oldPage = pm.getPagesSnapshot().pages[0];
    saveInactivePageElements(oldPage.id, [createElement("old")]);

    const imported = [
      { id: "ip1", name: "Imported 1", createdAt: 1, updatedAt: 1 },
      { id: "ip2", name: "Imported 2", createdAt: 2, updatedAt: 2 },
    ];
    pm.resetWithImportedPages(imported as any, "ip2", {
      ip1: [createElement("ie1")],
    });

    expect(pm.getActivePageId()).toBe("ip2");
    expect(loadPageElements(oldPage.id)).toBeNull(); // wiped
    expect(loadPageElements("ip1")).toHaveLength(1);
    expect(loadPageElements("ip2")).toBeNull(); // active page lives in scene
  });

  it("throws on unknown page activation or bad import state", async () => {
    const pm = await fresh();
    pm.initializePages();
    expect(() => pm.setActivePage("nope")).toThrow();
    expect(() =>
      (pm as any).resetWithImportedPages([], "x", {}),
    ).toThrow();
  });
});
