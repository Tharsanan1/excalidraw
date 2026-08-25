/**
 * Thin GitHub REST API wrapper for document sync.
 * No external dependencies — plain fetch.
 *
 * Docs are stored in a dedicated private repository, one file per document:
 *   excalidraw-docs/documents/<name>.excalidraw
 */

const API_BASE = "https://api.github.com";

export const GH_REPO_NAME = "excalidraw-docs";
export const GH_DOCS_DIR = "documents";

export type GhCredentials = {
  token: string;
  owner: string;
};

export type GhFileMeta = {
  name: string;
  path: string;
  sha: string;
  size: number;
};

export class GhApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GhApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "PUT" | "POST" | "DELETE";
  body?: unknown;
  rawResponse?: boolean;
  fetchImpl?: typeof fetch;
};

const ghRequest = async (
  credentials: GhCredentials,
  path: string,
  {
    method = "GET",
    body,
    rawResponse = false,
    fetchImpl = fetch,
  }: RequestOptions = {},
): Promise<{ data: any; status: number }> => {
  const response = await fetchImpl(
    path.startsWith("http") ? path : `${API_BASE}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Accept: rawResponse
          ? "application/vnd.github.raw"
          : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );

  if (!response.ok) {
    let detail = "";
    try {
      const json = await response.json();
      detail = json?.message ? `: ${json.message}` : "";
    } catch {}
    throw new GhApiError(
      `GitHub API ${method} ${path} failed with ${response.status}${detail}`,
      response.status,
    );
  }

  if (response.status === 204) {
    return { data: null, status: 204 };
  }

  const data = rawResponse ? await response.text() : await response.json();
  return { data, status: response.status };
};

/** validates a token and returns the authenticated user's login */
export const getAuthenticatedUser = async (
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const { data } = await ghRequest(
    { token, owner: "" },
    "/user",
    { fetchImpl },
  );
  return data.login as string;
};

export const repositoryExists = async (
  credentials: GhCredentials,
  fetchImpl?: typeof fetch,
): Promise<boolean> => {
  try {
    await ghRequest(
      credentials,
      `/repos/${credentials.owner}/${GH_REPO_NAME}`,
      { fetchImpl },
    );
    return true;
  } catch (error) {
    if (error instanceof GhApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
};

export const createRepository = async (
  credentials: GhCredentials,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  await ghRequest(credentials, "/user/repos", {
    method: "POST",
    body: {
      name: GH_REPO_NAME,
      private: true,
      description: "Excalidraw multi-page documents (auto-managed)",
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: true,
    },
    fetchImpl,
  });
};

/** ensures the documents dir exists (empty repos can't be listed) */
export const ensureDocumentsDir = async (
  credentials: GhCredentials,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  const path = `${GH_DOCS_DIR}/.gitkeep`;
  const existing = await getFileMeta(credentials, path, fetchImpl);
  if (!existing) {
    await putFile(credentials, path, "", undefined, fetchImpl);
  }
};

/** returns file metadata incl. blob sha, or null when the file doesn't exist */
export const getFileMeta = async (
  credentials: GhCredentials,
  path: string,
  fetchImpl?: typeof fetch,
): Promise<GhFileMeta | null> => {
  try {
    const { data } = await ghRequest(
      credentials,
      `/repos/${credentials.owner}/${GH_REPO_NAME}/contents/${path}`,
      { fetchImpl },
    );
    return {
      name: data.name,
      path: data.path,
      sha: data.sha,
      size: data.size,
    };
  } catch (error) {
    if (error instanceof GhApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

/**
 * Creates or updates a file. Pass the known blob `sha` to update; omit it to
 * create. Returns the new blob sha.
 */
export const putFile = async (
  credentials: GhCredentials,
  path: string,
  content: string,
  sha: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const { data } = await ghRequest(
    credentials,
    `/repos/${credentials.owner}/${GH_REPO_NAME}/contents/${path}`,
    {
      method: "PUT",
      body: {
        message: sha
          ? `Update ${path.split("/").pop()}`
          : `Create ${path.split("/").pop()}`,
        content: btoa(unescape(encodeURIComponent(content))),
        ...(sha ? { sha } : {}),
      },
      fetchImpl,
    },
  );
  return data.content.sha as string;
};

/** lists .excalidraw files in the documents directory */
export const listDocumentFiles = async (
  credentials: GhCredentials,
  fetchImpl?: typeof fetch,
): Promise<GhFileMeta[]> => {
  try {
    const { data } = await ghRequest(
      credentials,
      `/repos/${credentials.owner}/${GH_REPO_NAME}/contents/${GH_DOCS_DIR}`,
      { fetchImpl },
    );
    if (!Array.isArray(data)) {
      return [];
    }
    return data.filter(
      (item: any) =>
        item.type === "file" && item.name.endsWith(".excalidraw"),
    ) as GhFileMeta[];
  } catch (error) {
    if (error instanceof GhApiError && error.status === 404) {
      return [];
    }
    throw error;
  }
};

/** downloads raw file content (no base64, supports large files) */
export const getFileContent = async (
  credentials: GhCredentials,
  path: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const { data } = await ghRequest(
    credentials,
    `/repos/${credentials.owner}/${GH_REPO_NAME}/contents/${path}`,
    { rawResponse: true, fetchImpl },
  );
  return data as string;
};
