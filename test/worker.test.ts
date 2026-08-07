import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ACCESS_HEADERS = {
  "Cf-Access-Jwt-Assertion": "test-access-identity",
} as const;

let schemaReady = false;

async function resetBindings(): Promise<void> {
  if (!schemaReady) {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    schemaReady = true;
  }
  await env.DB.exec("DELETE FROM plan_versions; DELETE FROM plans;");
  const listed = await env.STORAGE.list();
  if (listed.objects.length > 0) {
    await env.STORAGE.delete(listed.objects.map((object) => object.key));
  }
}

async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function publish(
  method: "POST" | "PUT",
  path: string,
  body: string,
): Promise<Response> {
  return dispatch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...ACCESS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  }));
}

describe("plans Worker", () => {
  it("rejects requests that did not pass through Access", async () => {
    const response = await dispatch(
      new Request("http://localhost/api/v1/health"),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Cloudflare Access authentication required",
    });
  });

  it("creates and serves a stable plan URL", async () => {
    await resetBindings();
    const source = "<!doctype html><title>First</title><h1>First plan</h1>";
    const created = await publish(
      "POST",
      "/api/v1/plans?agent=codex&name=auth-refactor",
      source,
    );

    expect(created.status, await created.clone().text()).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      agent: "codex",
      name: "auth-refactor",
      version: 1,
      url: "https://plans.inds.space/codex/auth-refactor",
    });

    const viewed = await dispatch(
      new Request("http://localhost/codex/auth-refactor", {
        headers: ACCESS_HEADERS,
      }),
    );
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("X-Plan-Version")).toBe("1");
    expect(viewed.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    await expect(viewed.text()).resolves.toBe(source);
  });

  it("rejects duplicate create and preserves the existing plan", async () => {
    await resetBindings();
    await publish(
      "POST",
      "/api/v1/plans?agent=claude&name=duplicate",
      "<!doctype html><title>Original</title>",
    );
    const duplicate = await publish(
      "POST",
      "/api/v1/plans?agent=claude&name=duplicate",
      "<!doctype html><title>Replacement</title>",
    );
    expect(duplicate.status).toBe(409);

    const viewed = await dispatch(
      new Request("http://localhost/claude/duplicate", {
        headers: ACCESS_HEADERS,
      }),
    );
    await expect(viewed.text()).resolves.toContain("Original");
  });

  it("updates to a new immutable version without changing the URL", async () => {
    await resetBindings();
    await publish(
      "POST",
      "/api/v1/plans?agent=antigravity&name=dashboard",
      "<!doctype html><title>Version 1</title>",
    );
    const updated = await publish(
      "PUT",
      "/api/v1/plans/antigravity/dashboard",
      "<!doctype html><title>Version 2</title>",
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      version: 2,
      url: "https://plans.inds.space/antigravity/dashboard",
    });

    const rows = await env.DB.prepare(
      "SELECT version FROM plan_versions ORDER BY version",
    ).all<{ version: number }>();
    expect(rows.results.map((row) => row.version)).toEqual([1, 2]);

    const viewed = await dispatch(
      new Request("http://localhost/antigravity/dashboard", {
        headers: ACCESS_HEADERS,
      }),
    );
    expect(viewed.headers.get("X-Plan-Version")).toBe("2");
    await expect(viewed.text()).resolves.toContain("Version 2");
  });

  it("validates agents, slugs, media type, and upload size", async () => {
    await resetBindings();
    const unknownAgent = await publish(
      "POST",
      "/api/v1/plans?agent=gemini&name=valid-name",
      "<h1>Plan</h1>",
    );
    expect(unknownAgent.status).toBe(400);

    const badSlug = await publish(
      "POST",
      "/api/v1/plans?agent=codex&name=Not%20A%20Slug",
      "<h1>Plan</h1>",
    );
    expect(badSlug.status).toBe(400);

    const badType = await dispatch(
      new Request("http://localhost/api/v1/plans?agent=codex&name=plain-text", {
        method: "POST",
        headers: { ...ACCESS_HEADERS, "Content-Type": "text/plain" },
        body: "not html",
      }),
    );
    expect(badType.status).toBe(415);

    const tooLarge = await dispatch(
      new Request("http://localhost/api/v1/plans?agent=codex&name=too-large", {
        method: "POST",
        headers: {
          ...ACCESS_HEADERS,
          "Content-Type": "text/html",
          "Content-Length": "5242881",
        },
        body: "<h1>Small body, declared large</h1>",
      }),
    );
    expect(tooLarge.status).toBe(413);
  });

  it("deletes the plan record and stable URL", async () => {
    await resetBindings();
    await publish(
      "POST",
      "/api/v1/plans?agent=codex&name=temporary",
      "<!doctype html><title>Temporary</title>",
    );
    const deleted = await dispatch(
      new Request("http://localhost/api/v1/plans/codex/temporary", {
        method: "DELETE",
        headers: ACCESS_HEADERS,
      }),
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: true });

    const viewed = await dispatch(
      new Request("http://localhost/codex/temporary", {
        headers: ACCESS_HEADERS,
      }),
    );
    expect(viewed.status).toBe(404);
  });
});
