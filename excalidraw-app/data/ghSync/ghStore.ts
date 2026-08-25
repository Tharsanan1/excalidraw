/**
 * GitHub-backed cloud sync for multi-page documents.
 *
 * - Auth: Personal Access Token (classic or fine-grained) pasted by the user;
 *   validated against /user. Stored in localStorage (same trust boundary as
 *   the scene data itself).
 * - Storage: one private repo per user, one file per document.
 * - Conflicts: optimistic locking via blob SHA — if the remote changed since
 *   our last write, we never overwrite; the local version is saved alongside
 *   as "<name> (conflict <date>)".
 */

import {
  createRepository,
  ensureDocumentsDir,
  GH_DOCS_DIR,
  getAuthenticatedUser,
  getFileContent,
  getFileMeta,
  GhApiError,
  listDocumentFiles,
  putFile,
  repositoryExists,
  type GhCredentials,
  type GhFileMeta,
} from "./ghApi";

const STORAGE_KEY = "excalidraw-gh-sync";

export type GhSyncStatus =
  | "signedOut"
  | "connecting"
  | "ready"
  | "error";

export type GhSyncState = {
  status: GhSyncStatus;
  /** authenticated login when ready */
  user: string | null;
  error: string | null;
};

type PersistedAuth = {
  token: string;
  user: string;
};

// -----------------------------------------------------------------------------
// pure helpers (exported for tests)
// -----------------------------------------------------------------------------

/** filesystem-safe document slug */
export const slugifyDocumentName = (name: string): string => {
  const slug = name
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return slug || "Untitled";
};

export const toRemotePath = (docName: string): string =>
  `${GH_DOCS_DIR}/${slugifyDocumentName(docName)}.excalidraw`;

/** e.g. "My doc" -> "documents/My doc (conflict 2026-08-25 1432).excalidraw" */
export const conflictRemotePath = (remotePath: string, now = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dot = remotePath.lastIndexOf(".");
  return `${remotePath.slice(0, dot)} (conflict ${stamp})${remotePath.slice(dot)}`;
};

// -----------------------------------------------------------------------------
// reactive state
// -----------------------------------------------------------------------------

let state: GhSyncState = { status: "signedOut", user: null, error: null };
let credentials: GhCredentials | null = null;
/** last-known blob sha per path, for optimistic locking */
const knownShas = new Map<string, string>();

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const subscribeToGhSync = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getGhSyncSnapshot = (): GhSyncState => state;

const setState = (partial: Partial<GhSyncState>) => {
  state = { ...state, ...partial };
  notify();
};

const failWith = (error: unknown): never => {
  const message =
    error instanceof GhApiError
      ? error.status === 401
        ? "GitHub rejected the token (expired or insufficient scopes)."
        : error.message
      : error instanceof Error
        ? error.message
        : String(error);
  setState({ status: "error", error: message });
  throw error;
};

const persistAuth = (auth: PersistedAuth | null) => {
  try {
    if (auth) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
};

const readPersistedAuth = (): PersistedAuth | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return typeof parsed?.token === "string" && typeof parsed?.user === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

// -----------------------------------------------------------------------------
// lifecycle
// -----------------------------------------------------------------------------

/** restores a persisted session; validates silently in the background */
export const initializeGhSync = async (): Promise<void> => {
  const auth = readPersistedAuth();
  if (!auth) {
    return;
  }
  credentials = { token: auth.token, owner: auth.user };
  setState({ status: "connecting", user: auth.user, error: null });
  try {
    await ensureRepoReady();
    setState({ status: "ready", user: auth.user, error: null });
  } catch (error) {    // token likely revoked/expired — drop session rather than nag on every load
    credentials = null;
    persistAuth(null);
    setState({ status: "signedOut", user: null, error: null });
    console.warn("ghSync: stored session invalid", error);
  }
};

export const signInToGithub = async (
  token: string,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Token is required");
  }
  setState({ status: "connecting", error: null });
  try {
    const user = await getAuthenticatedUser(trimmed, fetchImpl);
    credentials = { token: trimmed, owner: user };
    persistAuth({ token: trimmed, user });
    await ensureRepoReady(fetchImpl);
    setState({ status: "ready", user, error: null });
  } catch (error) {
    credentials = null;
    persistAuth(null);
    setState({ status: "error", user: null, error: null });
    failWith(error);
  }
};

export const signOutOfGithub = () => {
  credentials = null;
  knownShas.clear();
  persistAuth(null);
  setState({ status: "signedOut", user: null, error: null });
};

const ensureRepoReady = async (fetchImpl?: typeof fetch) => {
  if (!credentials) {
    throw new Error("Not signed in");
  }
  if (!(await repositoryExists(credentials, fetchImpl))) {
    await createRepository(credentials, fetchImpl);
  }
  await ensureDocumentsDir(credentials, fetchImpl);
};

const assertReady = (): GhCredentials => {
  if (state.status !== "ready" || !credentials) {
    throw new Error("ghSync: not connected");
  }
  return credentials;
};

// -----------------------------------------------------------------------------
// document operations
// -----------------------------------------------------------------------------

export const listCloudDocuments = async (
  fetchImpl?: typeof fetch,
): Promise<GhFileMeta[]> => {
  return listDocumentFiles(assertReady(), fetchImpl);
};

export type SaveResult = {
  path: string;
  conflict: boolean;
};

/**
 * Saves a document under `docName`. If the remote file changed since our last
 * interaction, writes to a conflict copy instead of overwriting.
 */
export const saveDocumentToCloud = async (
  docName: string,
  content: string,
  fetchImpl?: typeof fetch,
): Promise<SaveResult> => {
  const creds = assertReady();
  const remotePath = toRemotePath(docName);

  const remoteMeta = await getFileMeta(creds, remotePath, fetchImpl);
  const lastKnownSha = knownShas.get(remotePath);

  let targetPath = remotePath;
  let targetSha: string | undefined = remoteMeta?.sha;

  if (remoteMeta && lastKnownSha && remoteMeta.sha !== lastKnownSha) {
    // someone else (or another tab/device) changed it — keep both versions
    targetPath = conflictRemotePath(remotePath);
    targetSha = undefined;
  }

  const newSha = await putFile(creds, targetPath, content, targetSha, fetchImpl);
  knownShas.set(targetPath, newSha);
  return { path: targetPath, conflict: targetPath !== remotePath };
};

export const loadDocumentFromCloud = async (
  path: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const creds = assertReady();
  const meta = await getFileMeta(creds, path, fetchImpl);
  if (meta) {
    knownShas.set(path, meta.sha);
  }
  return getFileContent(creds, path, fetchImpl);
};
