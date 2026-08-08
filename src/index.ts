import { AGENTS, isAgent, PLAN_SLUG_PATTERN, type Agent } from "./constants";
import { html, json, methodNotAllowed } from "./http";

interface PlanRow {
  id: string;
  agent: Agent;
  slug: string;
  object_key: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  object_key: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hasAccessIdentity(request: Request): boolean {
  return Boolean(
    request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ||
      request.headers.get("Cf-Access-Authenticated-User-Email")?.trim(),
  );
}

function parseAgent(value: string | null): Agent {
  if (!value || !isAgent(value)) {
    throw new HttpError(
      400,
      `Unknown agent. Supported agents: ${AGENTS.join(", ")}`,
    );
  }
  return value;
}

function parseSlug(value: string | null): string {
  if (!value || !PLAN_SLUG_PATTERN.test(value)) {
    throw new HttpError(
      400,
      "Plan name must be a lowercase slug of 1-64 letters, numbers, or hyphens",
    );
  }
  return value;
}

function parseMaxUploadBytes(env: CloudflareBindings): number {
  const parsed = Number.parseInt(env.MAX_UPLOAD_BYTES, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
}

function requireHtmlUpload(request: Request, env: CloudflareBindings): ReadableStream<Uint8Array> {
  if (!request.body) {
    throw new HttpError(400, "HTML body is required");
  }
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (contentType !== "text/html") {
    throw new HttpError(415, "Content-Type must be text/html");
  }

  const maximum = parseMaxUploadBytes(env);
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    throw new HttpError(411, "Content-Length is required for HTML uploads");
  }
  if (declaredLength > maximum) {
    throw new HttpError(413, `HTML exceeds the ${String(maximum)}-byte upload limit`);
  }
  return request.body;
}

function objectKey(agent: Agent, slug: string, version: number): string {
  return `${agent}/${slug}/versions/${String(version)}-${crypto.randomUUID()}.html`;
}

function canonicalUrl(env: CloudflareBindings, agent: Agent, slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${agent}/${slug}`;
}

function decodePathSegments(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Invalid URL path encoding");
  }
}

async function findPlan(
  env: CloudflareBindings,
  agent: Agent,
  slug: string,
): Promise<PlanRow | null> {
  return env.DB.prepare(
    "SELECT id, agent, slug, object_key, version, created_at, updated_at FROM plans WHERE agent = ? AND slug = ? LIMIT 1",
  )
    .bind(agent, slug)
    .first<PlanRow>();
}

async function listPlans(env: CloudflareBindings, url: URL): Promise<Response> {
  const requestedAgent = url.searchParams.get("agent");
  const statement = requestedAgent
    ? env.DB.prepare(
        "SELECT id, agent, slug, object_key, version, created_at, updated_at FROM plans WHERE agent = ? ORDER BY updated_at DESC, slug ASC",
      ).bind(parseAgent(requestedAgent))
    : env.DB.prepare(
        "SELECT id, agent, slug, object_key, version, created_at, updated_at FROM plans ORDER BY updated_at DESC, agent ASC, slug ASC",
      );
  const result = await statement.all<PlanRow>();
  return json({
    plans: result.results.map((plan) => ({
      agent: plan.agent,
      name: plan.slug,
      version: plan.version,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      url: canonicalUrl(env, plan.agent, plan.slug),
    })),
  });
}

async function createPlan(
  request: Request,
  env: CloudflareBindings,
  url: URL,
): Promise<Response> {
  const agent = parseAgent(url.searchParams.get("agent"));
  const slug = parseSlug(url.searchParams.get("name"));
  if (await findPlan(env, agent, slug)) {
    throw new HttpError(
      409,
      `Plan "${slug}" already exists for ${agent}. Use plan update.`,
    );
  }

  const body = requireHtmlUpload(request, env);
  const id = `pln_${crypto.randomUUID().replaceAll("-", "")}`;
  const version = 1;
  const key = objectKey(agent, slug, version);
  const now = new Date().toISOString();

  await env.STORAGE.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { agent, slug, planId: id, version: String(version) },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO plans (id, agent, slug, object_key, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, agent, slug, key, version, now, now),
      env.DB.prepare(
        "INSERT INTO plan_versions (plan_id, version, object_key, created_at) VALUES (?, ?, ?, ?)",
      ).bind(id, version, key, now),
    ]);
  } catch (error) {
    await env.STORAGE.delete(key);
    throw error;
  }

  return json(
    { agent, name: slug, version, url: canonicalUrl(env, agent, slug) },
    { status: 201 },
  );
}

async function updatePlan(
  request: Request,
  env: CloudflareBindings,
  agent: Agent,
  slug: string,
): Promise<Response> {
  const existing = await findPlan(env, agent, slug);
  if (!existing) {
    throw new HttpError(404, `Plan "${slug}" does not exist for ${agent}`);
  }

  const body = requireHtmlUpload(request, env);
  const version = existing.version + 1;
  const key = objectKey(agent, slug, version);
  const now = new Date().toISOString();

  await env.STORAGE.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      agent,
      slug,
      planId: existing.id,
      version: String(version),
    },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO plan_versions (plan_id, version, object_key, created_at) VALUES (?, ?, ?, ?)",
      ).bind(existing.id, version, key, now),
      env.DB.prepare(
        "UPDATE plans SET object_key = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      ).bind(key, version, now, existing.id, existing.version),
    ]);
  } catch (error) {
    await env.STORAGE.delete(key);
    throw error;
  }

  return json({
    agent,
    name: slug,
    version,
    url: canonicalUrl(env, agent, slug),
  });
}

async function deletePlan(
  env: CloudflareBindings,
  ctx: ExecutionContext,
  agent: Agent,
  slug: string,
): Promise<Response> {
  const existing = await findPlan(env, agent, slug);
  if (!existing) {
    throw new HttpError(404, `Plan "${slug}" does not exist for ${agent}`);
  }

  const versions = await env.DB.prepare(
    "SELECT object_key FROM plan_versions WHERE plan_id = ? ORDER BY version",
  )
    .bind(existing.id)
    .all<VersionRow>();

  await env.DB.prepare("DELETE FROM plans WHERE id = ?").bind(existing.id).run();
  const keys = versions.results.map((version) => version.object_key);
  if (keys.length > 0) {
    ctx.waitUntil(
      env.STORAGE.delete(keys).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "failed to remove deleted plan objects",
            agent,
            slug,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  }

  return json({ deleted: true, agent, name: slug });
}

async function servePlan(
  env: CloudflareBindings,
  agent: Agent,
  slug: string,
): Promise<Response> {
  const plan = await findPlan(env, agent, slug);
  if (!plan) {
    return html("<!doctype html><title>Plan not found</title><h1>Plan not found</h1>", {
      status: 404,
    });
  }
  const object = await env.STORAGE.get(plan.object_key);
  if (!object?.body) {
    console.error(
      JSON.stringify({
        message: "plan object missing",
        agent,
        slug,
        objectKey: plan.object_key,
      }),
    );
    return html(
      "<!doctype html><title>Plan unavailable</title><h1>Plan temporarily unavailable</h1>",
      { status: 503 },
    );
  }
  return html(object.body, {
    headers: {
      ETag: object.httpEtag,
      "Last-Modified": object.uploaded.toUTCString(),
      "X-Plan-Agent": plan.agent,
      "X-Plan-Version": String(plan.version),
    },
  });
}

function landingPage(env: CloudflareBindings): Response {
  return html(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>IND's Space Plans</title>
<style>body{font:16px/1.5 system-ui;background:#0b1020;color:#e7ebff;max-width:720px;margin:10vh auto;padding:24px}code{color:#8ee3c4}.card{border:1px solid #29314d;border-radius:18px;padding:24px;background:#12182b}</style>
<main class="card"><p>IND'S SPACE</p><h1>Plans</h1><p>Authenticated HTML plans for Claude, Codex, and Antigravity.</p><code>plan create &lt;name&gt; -codex</code><p>${env.PUBLIC_BASE_URL}</p></main></html>`);
}

async function route(
  request: Request,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!hasAccessIdentity(request)) {
    return json({ error: "Cloudflare Access authentication required" }, { status: 401 });
  }

  const url = new URL(request.url);
  const segments = decodePathSegments(url.pathname);

  if (segments.length === 0) {
    return request.method === "GET" ? landingPage(env) : methodNotAllowed(["GET"]);
  }

  if (segments.join("/") === "api/v1/health") {
    return request.method === "GET"
      ? json({ service: "plans", status: "ok" })
      : methodNotAllowed(["GET"]);
  }

  if (segments.join("/") === "api/v1/plans") {
    if (request.method === "GET") {
      return listPlans(env, url);
    }
    return request.method === "POST"
      ? createPlan(request, env, url)
      : methodNotAllowed(["GET", "POST"]);
  }

  if (segments.length === 5 && segments.slice(0, 3).join("/") === "api/v1/plans") {
    const agent = parseAgent(segments[3] ?? null);
    const slug = parseSlug(segments[4] ?? null);
    if (request.method === "PUT") {
      return updatePlan(request, env, agent, slug);
    }
    if (request.method === "DELETE") {
      return deletePlan(env, ctx, agent, slug);
    }
    return methodNotAllowed(["PUT", "DELETE"]);
  }

  if (segments.length === 2) {
    const agent = parseAgent(segments[0] ?? null);
    const slug = parseSlug(segments[1] ?? null);
    return request.method === "GET"
      ? servePlan(env, agent, slug)
      : methodNotAllowed(["GET"]);
  }

  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(
    request: Request,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, { status: error.status });
      }
      console.error(
        JSON.stringify({
          message: "unhandled request error",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const hostname = new URL(request.url).hostname;
      return json(
        {
          error: "Internal server error",
          ...(hostname === "localhost" || hostname === "127.0.0.1"
            ? { detail: error instanceof Error ? error.message : String(error) }
            : {}),
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<CloudflareBindings>;
