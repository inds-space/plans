const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function json(
  body: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return Response.json(body, { ...init, headers });
}

export function methodNotAllowed(methods: readonly string[]): Response {
  return json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: methods.join(", ") } },
  );
}

export function html(body: BodyInit, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; frame-ancestors 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  );
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

