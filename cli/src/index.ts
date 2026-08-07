#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AGENTS, isAgent, PLAN_SLUG_PATTERN, type Agent } from "../../src/constants";

const VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://plans.inds.space";
const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

interface PlanConfig {
  baseUrl?: string;
  accessClientId?: string;
  accessClientSecret?: string;
  apiToken?: string;
}

interface ParsedArgs {
  command: "create" | "update" | "delete";
  name: string;
  agent: Agent;
  file?: string;
  yes: boolean;
}

interface ApiResult {
  error?: string;
  url?: string;
  version?: number;
  deleted?: boolean;
}

function usage(): string {
  return `plan ${VERSION}

Usage:
  plan create <name> -<agent> [--file <path>]
  plan update <name> -<agent> [--file <path>]
  plan delete <name> -<agent> [--yes]

Agents:
  ${AGENTS.map((agent) => `-${agent}`).join("  ")}

HTML discovery order:
  <name>.html, .plans/<agent>/<name>.html, .plans/<name>.html, plan.html, index.html

Authentication:
  Set PLAN_ACCESS_CLIENT_ID and PLAN_ACCESS_CLIENT_SECRET, or create the config
  file shown in the repository README.`;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, name, ...rest] = argv;
  if (command !== "create" && command !== "update" && command !== "delete") {
    throw new Error("Expected create, update, or delete");
  }
  if (!name || !PLAN_SLUG_PATTERN.test(name)) {
    throw new Error(
      "Plan name must be a lowercase slug of 1-64 letters, numbers, or hyphens",
    );
  }

  let agent: Agent | undefined;
  let file: string | undefined;
  let yes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--file") {
      const value = rest[index + 1];
      if (!value) throw new Error("--file requires a path");
      file = value;
      index += 1;
      continue;
    }
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    if (argument?.startsWith("-") && isAgent(argument.slice(1))) {
      if (agent) throw new Error("Specify exactly one agent");
      agent = argument.slice(1) as Agent;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }

  if (!agent) {
    throw new Error(`Specify one agent: ${AGENTS.map((value) => `-${value}`).join(", ")}`);
  }
  if (command === "delete" && file) {
    throw new Error("--file is not valid for delete");
  }
  return { command, name, agent, file, yes };
}

function configPath(): string {
  if (process.env.PLAN_CONFIG) return resolve(process.env.PLAN_CONFIG);
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "plan", "config.json");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "plan", "config.json");
}

async function readConfig(): Promise<PlanConfig> {
  try {
    const contents = await readFile(configPath(), "utf8");
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must contain a JSON object");
    }
    const candidate = parsed as Record<string, unknown>;
    return {
      baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : undefined,
      accessClientId:
        typeof candidate.accessClientId === "string" ? candidate.accessClientId : undefined,
      accessClientSecret:
        typeof candidate.accessClientSecret === "string"
          ? candidate.accessClientSecret
          : undefined,
      apiToken: typeof candidate.apiToken === "string" ? candidate.apiToken : undefined,
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return {};
    throw new Error(
      `Could not read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function requestHeaders(config: PlanConfig): Headers {
  const headers = new Headers({ Accept: "application/json" });
  const clientId = process.env.PLAN_ACCESS_CLIENT_ID ?? config.accessClientId;
  const clientSecret = process.env.PLAN_ACCESS_CLIENT_SECRET ?? config.accessClientSecret;
  const apiToken = process.env.PLAN_API_TOKEN ?? config.apiToken;

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error("Both Cloudflare Access client ID and secret are required");
    }
    headers.set("CF-Access-Client-Id", clientId);
    headers.set("CF-Access-Client-Secret", clientSecret);
  }
  if (apiToken) headers.set("Authorization", `Bearer ${apiToken}`);
  return headers;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveHtmlFile(args: ParsedArgs): Promise<string> {
  if (args.file) {
    const explicit = resolve(args.file);
    if (!(await isFile(explicit))) throw new Error(`HTML file not found: ${explicit}`);
    return explicit;
  }

  const candidates = [
    `${args.name}.html`,
    join(".plans", args.agent, `${args.name}.html`),
    join(".plans", `${args.name}.html`),
    "plan.html",
    "index.html",
  ].map((candidate) => resolve(candidate));
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    `No HTML file found for "${args.name}". Create ${args.name}.html or pass --file <path>.`,
  );
}

async function parseResponse(response: Response): Promise<ApiResult> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const value = payload as Record<string, unknown>;
  return {
    error: typeof value.error === "string" ? value.error : undefined,
    url: typeof value.url === "string" ? value.url : undefined,
    version: typeof value.version === "number" ? value.version : undefined,
    deleted: typeof value.deleted === "boolean" ? value.deleted : undefined,
  };
}

async function confirmDelete(name: string, agent: Agent): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  process.stdout.write(`Delete ${agent}/${name}? This removes its stable URL. [y/N] `);
  const answer = await new Promise<string>((resolveAnswer) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data: string) => {
      resolveAnswer(data);
    });
  });
  return /^y(?:es)?$/i.test(answer.trim());
}

async function run(args: ParsedArgs): Promise<void> {
  const config = await readConfig();
  const baseUrl = (process.env.PLAN_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const headers = requestHeaders(config);

  if (args.command === "delete") {
    if (!args.yes && !(await confirmDelete(args.name, args.agent))) {
      throw new Error("Delete cancelled. In non-interactive use, pass --yes after explicit approval.");
    }
    const response = await fetch(
      `${baseUrl}/api/v1/plans/${args.agent}/${args.name}`,
      { method: "DELETE", headers },
    );
    const result = await parseResponse(response);
    if (!response.ok) {
      throw new Error(
        result.error ?? `Delete failed with HTTP ${String(response.status)}`,
      );
    }
    process.stdout.write(`Deleted ${args.agent}/${args.name}\n`);
    return;
  }

  const file = await resolveHtmlFile(args);
  const info = await stat(file);
  if (info.size > DEFAULT_MAX_UPLOAD_BYTES) {
    throw new Error(`${basename(file)} exceeds the 5 MiB upload limit`);
  }
  const body = await readFile(file);
  headers.set("Content-Type", "text/html; charset=utf-8");

  const endpoint =
    args.command === "create"
      ? `${baseUrl}/api/v1/plans?agent=${args.agent}&name=${args.name}`
      : `${baseUrl}/api/v1/plans/${args.agent}/${args.name}`;
  const response = await fetch(endpoint, {
    method: args.command === "create" ? "POST" : "PUT",
    headers,
    body,
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      result.error ?? `${args.command} failed with HTTP ${String(response.status)}`,
    );
  }
  if (!result.url) throw new Error("Server response did not include a plan URL");
  process.stdout.write(`${result.url}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    await run(parseArgs(argv));
    return 0;
  } catch (error) {
    process.stderr.write(`plan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
