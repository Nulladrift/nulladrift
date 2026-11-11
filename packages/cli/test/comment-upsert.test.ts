/**
 * Which comment `check --comment` replaces.
 *
 * It took the first comment starting with its marker, whoever wrote it. Anybody can comment on a
 * public pull request, so the marker posted first by somebody else meant the edit was refused and
 * the findings never appeared -- or the edit was allowed and the findings landed in a comment that
 * person could rewrite afterwards. Found in a security review.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { upsertComment } from "../src/report/comment";

const MARKER = "<!-- nulladrift:surface -->";

interface Seen {
  method: string;
  path: string;
}

async function github(options: { self?: string; comments: Array<{ id: number; body: string; user: { login: string; type: string } }>; patchStatus?: number }) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push({ method: request.method ?? "GET", path });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on("end", () => {
      if (path === "/user") return options.self ? json(200, { login: options.self }) : json(403, { message: "Resource not accessible by integration" });
      if (request.method === "GET" && path.startsWith("/repos/acme/web/issues/7/comments")) return json(200, options.comments);
      if (request.method === "PATCH") return json(options.patchStatus ?? 200, {});
      if (request.method === "POST") return json(201, { id: 999 });
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const target = { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repo: "acme/web", issue: 7, token: "t" };
  return { seen, target };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const writes = (seen: Seen[]) => seen.filter((request) => request.method === "PATCH" || request.method === "POST");

describe("the comment it replaces", () => {
  it("leaves a marked comment somebody else wrote alone, and posts its own", async () => {
    const { seen, target } = await github({ comments: [{ id: 99, body: `${MARKER}\nnothing to see`, user: { login: "drive-by-commenter", type: "User" } }] });

    expect(await upsertComment(target, "findings")).toBe("created");
    expect(writes(seen)).toEqual([{ method: "POST", path: "/repos/acme/web/issues/7/comments" }]);
  });

  it("replaces its own, as the workflow's bot", async () => {
    const { seen, target } = await github({
      comments: [
        { id: 99, body: `${MARKER}\nplanted`, user: { login: "drive-by-commenter", type: "User" } },
        { id: 100, body: `${MARKER}\nlast run`, user: { login: "github-actions[bot]", type: "Bot" } },
      ],
    });

    expect(await upsertComment(target, "findings")).toBe("updated");
    expect(writes(seen)).toEqual([{ method: "PATCH", path: "/repos/acme/web/issues/comments/100" }]);
  });

  it("replaces its own, as the person a personal token belongs to", async () => {
    const { seen, target } = await github({ self: "release-bot", comments: [{ id: 5, body: `${MARKER}\nlast run`, user: { login: "release-bot", type: "User" } }] });

    expect(await upsertComment(target, "findings")).toBe("updated");
    expect(writes(seen)).toEqual([{ method: "PATCH", path: "/repos/acme/web/issues/comments/5" }]);
  });

  it("posts a new comment when its own can no longer be edited", async () => {
    const { seen, target } = await github({ comments: [{ id: 100, body: `${MARKER}\nlast run`, user: { login: "github-actions[bot]", type: "Bot" } }], patchStatus: 403 });

    expect(await upsertComment(target, "findings")).toBe("created");
    expect(writes(seen).map((request) => request.method)).toEqual(["PATCH", "POST"]);
  });
});
