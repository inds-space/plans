export const AGENTS = ["claude", "codex", "antigravity"] as const;

export type Agent = (typeof AGENTS)[number];

export const PLAN_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}

