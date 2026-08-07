---
name: planning-html
description: Create, publish, revise, and remove rich self-contained HTML implementation plans with the IND's Space Plan CLI. Use when a user asks for a visual implementation plan, architecture plan, execution plan, or a plans.inds.space URL from Claude, Codex, or Antigravity.
---

# Planning HTML

Create a useful plan artifact, publish it under the current agent namespace, and return its stable URL.

## Workflow

1. Choose a lowercase hyphenated slug, 1-64 characters.
2. Determine the agent identity: `codex`, `claude`, or `antigravity`.
3. Copy `assets/plan-template.html` to `<slug>.html` and replace every placeholder.
4. Make the plan self-contained. Use inline CSS and JavaScript only; do not load remote scripts, fonts, images, or styles.
5. Include the outcome, scope, architecture, ordered phases, concrete file or system changes, validation, risks, and open decisions. Omit empty sections.
6. Publish a new plan with `plan create <slug> -<agent> --file <slug>.html`.
7. Revise the same file and use `plan update <slug> -<agent> --file <slug>.html` for later versions.
8. Return only the stable `https://plans.inds.space/<agent>/<slug>` URL plus one concise description.

Use `plan delete <slug> -<agent>` only after the user explicitly asks to delete that exact plan. Never place secrets, credentials, personal data, or production dumps in the HTML.

