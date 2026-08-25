import {
  loginIcon,
  ExcalLogo,
  eyeIcon,
  downloadIcon,
  file,
  GithubIcon,
  pencilIcon as editIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { isExcalidrawPlusSignedUser } from "../app_constants";
import {
  downloadMultiPageDocument,
  exportMultiPageDocument,
  openMultiPageDocumentPicker,
} from "../data/multipageDocument";
import {
  getGhSyncSnapshot,
  saveDocumentToCloud,
  signOutOfGithub,
  subscribeToGhSync,
} from "../data/ghSync/ghStore";
import { GhSyncDialogs } from "./GhSyncDialogs";

import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  excalidrawAPI?: any;
}> = React.memo((props) => {
  const { t } = useI18n();
  const gh = React.useSyncExternalStore(subscribeToGhSync, getGhSyncSnapshot);
  const [ghDialog, setGhDialog] = React.useState<
    "closed" | "signIn" | "open"
  >("closed");
  const [ghBusy, setGhBusy] = React.useState(false);

  const ghReady = gh.status === "ready" && !!props.excalidrawAPI;

  const handleSaveToGithub = async () => {
    if (!props.excalidrawAPI) {
      return;
    }
    setGhBusy(true);
    try {
      const doc = exportMultiPageDocument(props.excalidrawAPI);
      const result = await saveDocumentToCloud(
        props.excalidrawAPI.getName() || "Untitled",
        JSON.stringify(doc),
      );
      alert(
        result.conflict
          ? `${t("github.conflictNotice")}\n${result.path}`
          : t("github.savedToCloud"),
      );
    } catch (error) {
      console.error(error);
      alert(t("github.saveFailed"));
    }
    setGhBusy(false);
  };

  return (
    <>
      <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {props.excalidrawAPI && !props.isCollaborating && (
        <>
          <MainMenu.Item
            icon={downloadIcon}
            onSelect={() =>
              downloadMultiPageDocument(props.excalidrawAPI)
            }
          >
            {t("pages.exportDocument")}
          </MainMenu.Item>
          <MainMenu.Item
            icon={file}
            onSelect={() =>
              openMultiPageDocumentPicker(props.excalidrawAPI)
            }
          >
            {t("pages.importDocument")}
          </MainMenu.Item>
        </>
      )}
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      {props.excalidrawAPI && (
        <MainMenu.Item
          icon={editIcon}
          onSelect={() => {
            const currentName = props.excalidrawAPI.getName();
            const newName = window.prompt(
              t("pages.renameDocument"),
              currentName,
            );
            if (newName && newName.trim()) {
              props.excalidrawAPI.updateScene({
                appState: { name: newName.trim() },
              });
            }
          }}
        >
          {t("pages.renameDocument")}
        </MainMenu.Item>
      )}
      {!ghReady && (
        <MainMenu.Item
          icon={GithubIcon}
          onSelect={() => setGhDialog("signIn")}
        >
          {t("github.signIn")}
        </MainMenu.Item>
      )}
      {ghReady && (
        <>
          <MainMenu.Item
            icon={GithubIcon}
            disabled={ghBusy}
            onSelect={handleSaveToGithub}
          >
            {ghBusy ? t("github.saving") : t("github.saveDocument")}
          </MainMenu.Item>
          <MainMenu.Item
            icon={file}
            onSelect={() => setGhDialog("open")}
          >
            {t("github.openDocuments")}
          </MainMenu.Item>
          <MainMenu.Item icon={loginIcon} onSelect={signOutOfGithub}>
            {`${t("github.signOut")} (${gh.user})`}
          </MainMenu.Item>
        </>
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.ItemLink
        icon={ExcalLogo}
        href={`${
          import.meta.env.VITE_APP_PLUS_LP
        }/plus?utm_source=excalidraw&utm_medium=app&utm_content=hamburger`}
        className=""
      >
        Excalidraw+
      </MainMenu.ItemLink>
      <MainMenu.DefaultItems.Socials />
      <MainMenu.ItemLink
        icon={loginIcon}
        href={`${import.meta.env.VITE_APP_PLUS_APP}${
          isExcalidrawPlusSignedUser ? "" : "/sign-up"
        }?utm_source=signin&utm_medium=app&utm_content=hamburger`}
        className="highlighted"
      >
        {isExcalidrawPlusSignedUser ? t("labels.signIn") : t("labels.signUp")}
      </MainMenu.ItemLink>
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      {props.excalidrawAPI && (
        <GhSyncDialogs
          excalidrawAPI={props.excalidrawAPI}
          mode={ghDialog}
          onClose={() => setGhDialog("closed")}
        />
      )}
    </>
  );
});
