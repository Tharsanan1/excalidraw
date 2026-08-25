import { afterEach, describe, expect, it, vi } from "vitest";

import {
  conflictRemotePath,
  signInToGithub,
  signOutOfGithub,
  slugifyDocumentName,
  saveDocumentToCloud,
  toRemotePath,
} from "../data/ghSync/ghStore";
import { GhApiError } from "../data/ghSync/ghApi";

// minimal fetch mock returning JSON responses
const jsonRes = (data: any, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }) as Response;

describe("ghSync helpers", () => {
  it("slugifies document names for remote paths", () => {
    expect(toRemotePath("My Doc")).toBe("documents/My Doc.excalidraw");
    expect(slugifyDocumentName('a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a-b-c-d-e-f-g-h-i-j",
    );
    expect(slugifyDocumentName("   ")).toBe("Untitled");
    // long names are capped
    expect(slugifyDocumentName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("builds conflict paths with a timestamp", () => {
    const date = new Date(2026, 7, 25, 14, 32);
    expect(conflictRemotePath("documents/My doc.excalidraw", date)).toBe(
      "documents/My doc (conflict 2026-08-25 1432).excalidraw",
    );
  });
});

describe("ghStore flow", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    signOutOfGithub();
  });

  const stubAuthFlow = () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/user")) {
        return jsonRes({ login: "octocat" });
      }
      if (url.includes("/repos/octocat/excalidraw-docs") && !init?.method) {
        return jsonRes({ id: 1 });
      }
      if (url.includes("/contents/documents/.gitkeep")) {
        if (!init?.method) {
          return jsonRes({ message: "Not Found" }, 404) as any;
        }
        return jsonRes({
          content: { sha: "sha-gitkeep" },
        });
      }
      return jsonRes({});
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock };
  };

  it("signs in, provisions the repo and persists the session", async () => {
    stubAuthFlow();
    await signInToGithub("tok123");

    const snapshot = await import("../data/ghSync/ghStore").then((m) =>
      m.getGhSyncSnapshot(),
    );
    expect(snapshot.status).toBe("ready");
    expect(snapshot.user).toBe("octocat");

    // session persisted
    expect(
      JSON.parse(localStorage.getItem("excalidraw-gh-sync")!).user,
    ).toBe("octocat");
  });

  it("rejects an invalid token", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        throw new GhApiError("bad credentials", 401);
      }
      return jsonRes({});
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(signInToGithub("bad-token")).rejects.toThrow();
    expect(localStorage.getItem("excalidraw-gh-sync")).toBeNull();
  });

  it("detects remote changes and saves a conflict copy instead of overwriting", async () => {
    stubAuthFlow();
    await signInToGithub("tok123");

    let remoteSha = "remote-sha-1";
    const putBodies: any[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("contents/documents/My%20doc.excalidraw") ||
          url.includes("documents/My doc.excalidraw")) {
        if (method === "GET") {
          return jsonRes({ name: "My doc.excalidraw", sha: remoteSha, size: 1 });
        }
        putBodies.push(JSON.parse(init.body));
        return jsonRes({ content: { sha: "new-local-sha" } });
      }
      if (url.includes("(conflict")) {
        putBodies.push(JSON.parse(init.body));
        return jsonRes({ content: { sha: "conflict-sha" } });
      }
      return jsonRes({});
    }) as unknown as typeof fetch;

    // first save: creates the file, remembers its sha
    const first = await saveDocumentToCloud("My doc", "v1", fetchMock);
    expect(first.conflict).toBe(false);
    expect(remoteSha).toBeDefined();

    // simulate another device pushing a different version
    remoteSha = "remote-sha-changed-by-other-device";

    const second = await saveDocumentToCloud("My doc", "v2", fetchMock);
    expect(second.conflict).toBe(true);
    expect(second.path).toContain("(conflict ");
    // the conflict PUT must not carry the remote sha (pure create)
    const conflictPut = putBodies[putBodies.length - 1];
    expect(conflictPut.sha).toBeUndefined();
  });
});
