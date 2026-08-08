# Plan CLI

Authenticated static HTML plans for Claude, Codex, and Antigravity.

```text
plan create auth-refactor -codex
https://plans.inds.space/codex/auth-refactor
```

The repository contains one Cloudflare Worker, one D1 database, one R2 bucket, a standalone CLI distributed through GitHub Releases, and the `planning-html` skill.

## Commands

```bash
plan create <name> -claude|codex|antigravity [--file <path>]
plan update <name> -claude|codex|antigravity [--file <path>]
plan delete <name> -claude|codex|antigravity
plan list [-claude|-codex|-antigravity]
```

`create` and `update` discover `<name>.html` in the current directory. `--file` overrides discovery. Successful publication prints only the stable URL so agents can capture stdout directly. `list` prints every plan's agent, name, version, update time, and stable URL; pass an optional agent flag to filter the results.

## Authentication

Protect the entire `plans.inds.space` hostname with a Cloudflare Access application. Add a Service Auth policy for CLI clients and provide its service token through environment variables:

```powershell
$env:PLAN_ACCESS_CLIENT_ID = "..."
$env:PLAN_ACCESS_CLIENT_SECRET = "..."
```

Or copy `config.example.json` to `%APPDATA%\plan\config.json` on Windows or `~/.config/plan/config.json` on Unix. Keep the real config out of Git.

The Worker requires the Access identity header and has `workers.dev` plus preview URLs disabled. Access remains the security boundary; do not attach an unprotected route to this Worker.

## Local development

```bash
pnpm install
pnpm run types
pnpm run check
pnpm test
pnpm run dev
```

Apply the D1 migration locally with:

```bash
pnpm wrangler d1 migrations apply plans-db --local
```

Requests made directly to local Wrangler must include a test `Cf-Access-Jwt-Assertion` header.

## Provision and deploy

1. Create `plans-db` with `pnpm wrangler d1 create plans-db` and replace the placeholder `database_id` in `wrangler.jsonc`.
2. Create `plans-storage` with `pnpm wrangler r2 bucket create plans-storage`.
3. Apply migrations with `pnpm wrangler d1 migrations apply plans-db --remote`.
4. Create the Cloudflare Access application and Service Auth policy for `plans.inds.space/*`.
5. Deploy with `pnpm wrangler deploy`.

Deployment changes live Cloudflare state and should be performed only after reviewing the account, hostname, Access policy, and generated dry-run bundle.

## Skill

Install the same skill into the supported agent homes:

```powershell
.\scripts\install-skill.ps1
```

Custom locations can be supplied with `-Targets`. The source skill remains at `skills/planning-html` for versioned distribution.
