import { useEffect, useState, useSyncExternalStore } from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  getGhSyncSnapshot,
  initializeGhSync,
  listCloudDocuments,
  loadDocumentFromCloud,
  signInToGithub,
  subscribeToGhSync,
} from "../data/ghSync/ghStore";
import { importMultiPageDocument } from "../data/multipageDocument";

import "./GhSync.scss";

type DialogMode = "closed" | "signIn" | "open" | "message";

export const GhSyncDialogs = ({
  excalidrawAPI,
  mode,
  onClose,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  mode: DialogMode;
  onClose: () => void;
}) => {
  const gh = useSyncExternalStore(subscribeToGhSync, getGhSyncSnapshot);

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [documents, setDocuments] = useState<
    { name: string; path: string }[] | null
  >(null);

  useEffect(() => {
    initializeGhSync();
  }, []);

  useEffect(() => {
    if (mode === "open" && gh.status === "ready") {
      listCloudDocuments()
        .then((docs) =>
          setDocuments(
            docs.map((d) => ({
              name: d.name.replace(/\.excalidraw$/, ""),
              path: d.path,
            })),
          ),
        )
        .catch(() => setDocuments([]));
    }
  }, [mode, gh.status]);

  if (mode === "closed") {
    return null;
  }

  return (
    <div
      className="gh-sync-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="gh-sync-dialog" role="dialog" aria-modal="true">
        <div className="gh-sync-dialog__header">
          <span>{t("github.dialogTitle")}</span>
          <button
            type="button"
            className="gh-sync-dialog__close"
            onClick={onClose}
            aria-label={t("buttons.close")}
          >
            ×
          </button>
        </div>

        {mode === "signIn" && (
          <div className="gh-sync-signin">
            <p className="gh-sync-signin__hint">{t("github.signInHint")}</p>
            <a
              className="gh-sync-signin__link"
              href="https://github.com/settings/tokens/new?scopes=repo&description=Excalidraw%20cloud%20sync"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("github.createToken")}
            </a>
            <input
              type="password"
              className="gh-sync-signin__input"
              placeholder={t("github.tokenPlaceholder")}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
            />
            {gh.error && (
              <p className="gh-sync-error">{String(gh.error)}</p>
            )}
            <button
              type="button"
              className="gh-sync-button gh-sync-button--primary"
              disabled={busy || !token.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await signInToGithub(token);
                  setToken("");
                  onClose();
                } catch {}
                setBusy(false);
              }}
            >
              {busy ? t("github.connecting") : t("github.signIn")}
            </button>
          </div>
        )}

        {mode === "open" && gh.status === "ready" && (
          <div className="gh-sync-doclist">
            {documents === null && (
              <p className="gh-sync-muted">{t("github.loading")}</p>
            )}
            {documents?.length === 0 && (
              <p className="gh-sync-muted">{t("github.noDocuments")}</p>
            )}
            {documents?.map((doc) => (
              <button
                key={doc.path}
                type="button"
                className="gh-sync-doclist__item"
                onClick={async () => {
                  try {
                    const content = await loadDocumentFromCloud(doc.path);
                    const file = new File([content], doc.name + ".excalidraw", {
                      type: "application/json",
                    });
                    await importMultiPageDocument(file, excalidrawAPI);
                    onClose();
                  } catch (error) {
                    console.error(error);
                    alert(t("github.loadFailed"));
                  }
                }}
              >
                {doc.name}
              </button>
            ))}
          </div>
        )}

        {mode === "open" && gh.status !== "ready" && (
          <p className="gh-sync-muted">{t("github.notConnected")}</p>
        )}
      </div>
    </div>
  );
};
