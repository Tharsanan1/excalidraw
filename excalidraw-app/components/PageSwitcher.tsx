import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  addPage,
  deletePage,
  duplicatePage,
  getPagesSnapshot,
  initializePages,
  loadPageElements,
  movePage,
  renamePage,
  saveInactivePageElements,
  setActivePage,
  subscribeToPages,
  updatePageViewport,
} from "../data/pageManager";

import "./PageSwitcher.scss";

type ContextMenuState = { pageId: string; top: number; left: number } | null;

const isTextEntryTarget = (target: EventTarget | null) => {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
};

export const PageSwitcher = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  useEffect(() => {
    initializePages();
  }, []);

  const { pages, activePageId } = useSyncExternalStore(
    subscribeToPages,
    getPagesSnapshot,
  );

  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // close context menu on outside interaction / resize
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  /** persists the outgoing page's elements + viewport before leaving it */
  const persistOutgoingPage = useCallback(
    (outgoingPageId: string) => {
      if (outgoingPageId === activePageId) {
        const appState = excalidrawAPI.getAppState();
        saveInactivePageElements(
          outgoingPageId,
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );
        updatePageViewport(outgoingPageId, {
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom?.value,
        });
      }
    },
    [activePageId, excalidrawAPI],
  );

  const loadAndShowPage = useCallback(
    (pageId: string) => {
      const page =
        getPagesSnapshot().pages.find((p) => p.id === pageId) ?? null;
      const rawElements: readonly ExcalidrawElement[] | null =
        loadPageElements(pageId);

      excalidrawAPI.updateScene({
        elements: restoreElements(rawElements ?? [], null, {
          repairBindings: true,
        }),
        appState: {
          scrollX: page?.scrollX ?? 0,
          scrollY: page?.scrollY ?? 0,
          zoom: { value: (page?.zoom ?? 1) as NormalizedZoomValue },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // undo history is per-scene; switching pages invalidates it
      excalidrawAPI.history.clear();
      setActivePage(pageId);
    },
    [excalidrawAPI],
  );

  const switchToPage = useCallback(
    (pageId: string) => {
      if (!activePageId || pageId === activePageId) {
        return;
      }
      persistOutgoingPage(activePageId);
      loadAndShowPage(pageId);
    },
    [activePageId, loadAndShowPage, persistOutgoingPage],
  );

  const handleAddPage = useCallback(() => {
    if (activePageId) {
      persistOutgoingPage(activePageId);
    }
    const page = addPage();
    excalidrawAPI.updateScene({
      elements: [],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    excalidrawAPI.history.clear();
    setActivePage(page.id);
  }, [activePageId, excalidrawAPI, persistOutgoingPage]);

  const handleDeletePage = useCallback(
    (pageId: string) => {
      const page = pages.find((p) => p.id === pageId);
      if (!page || pages.length <= 1) {
        return;
      }
      if (!window.confirm(t("pages.confirmDelete", { name: page.name }) as string)) {
        return;
      }
      const { nextActivePageId, deletedWasActive } = deletePage(pageId);
      if (deletedWasActive && nextActivePageId) {
        loadAndShowPage(nextActivePageId);
      }
    },
    [pages, loadAndShowPage],
  );

  const handleDuplicatePage = useCallback(
    (pageId: string) => {
      // when duplicating the active page its latest elements are still in the
      // scene, not yet persisted under the page-specific storage key
      duplicatePage(
        pageId,
        pageId === activePageId
          ? excalidrawAPI.getSceneElementsIncludingDeleted()
          : undefined,
      );
    },
    [activePageId, excalidrawAPI],
  );

  // keyboard navigation: Shift+Alt+ArrowLeft/Right
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.shiftKey ||
        !event.altKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        isTextEntryTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      const currentIndex = pages.findIndex((p) => p.id === activePageId);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        event.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
      const nextPage = pages[nextIndex];
      if (nextPage) {
        switchToPage(nextPage.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pages, activePageId, switchToPage]);

  if (!activePageId) {
    return null;
  }

  return (
    <div className="page-switcher" data-testid="page-switcher">
      <div className="page-switcher__tabs" role="tablist">
        {pages.map((page) => {
          const isActive = page.id === activePageId;
          const isRenaming = renamingPageId === page.id;
          return (
            <div
              key={page.id}
              className={clsx("page-switcher__tab", {
                "page-switcher__tab--active": isActive,
              })}
              role="tab"
              aria-selected={isActive}
              aria-label={t("pages.pageLabel", { name: page.name })}
              title={page.name}
              onClick={() => switchToPage(page.id)}
              onDoubleClick={() => setRenamingPageId(page.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                const rect = (
                  event.currentTarget as HTMLElement
                ).getBoundingClientRect();
                setContextMenu({
                  pageId: page.id,
                  top: rect.bottom + 4,
                  left: rect.left,
                });
              }}
            >
              {isRenaming ? (
                <input
                  className="page-switcher__rename-input"
                  defaultValue={page.name}
                  autoFocus
                  aria-label={t("pages.rename")}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    renamePage(page.id, event.target.value);
                    setRenamingPageId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      renamePage(page.id, event.currentTarget.value);
                      setRenamingPageId(null);
                    } else if (event.key === "Escape") {
                      setRenamingPageId(null);
                    }
                  }}
                />
              ) : (
                <span className="page-switcher__name">{page.name}</span>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="page-switcher__add-button"
        title={t("pages.addPage")}
        aria-label={t("pages.addPage")}
        onClick={handleAddPage}
      >
        +
      </button>

      {contextMenu && (
        <div
          className="page-switcher__context-menu"
          style={{ top: contextMenu.top, left: contextMenu.left }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenamingPageId(contextMenu.pageId);
              setContextMenu(null);
            }}
          >
            {t("pages.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              handleDuplicatePage(contextMenu.pageId);
              setContextMenu(null);
            }}
          >
            {t("pages.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              pages.findIndex((p) => p.id === contextMenu.pageId) === 0
            }
            onClick={() => {
              movePage(contextMenu.pageId, "left");
              setContextMenu(null);
            }}
          >
            {t("pages.moveLeft")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              pages.findIndex((p) => p.id === contextMenu.pageId) ===
              pages.length - 1
            }
            onClick={() => {
              movePage(contextMenu.pageId, "right");
              setContextMenu(null);
            }}
          >
            {t("pages.moveRight")}
          </button>
          <div className="page-switcher__context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="page-switcher__context-menu-danger"
            disabled={pages.length <= 1}
            onClick={() => {
              handleDeletePage(contextMenu.pageId);
              setContextMenu(null);
            }}
          >
            {t("pages.delete")}
          </button>
        </div>
      )}
    </div>
  );
};

export default PageSwitcher;
