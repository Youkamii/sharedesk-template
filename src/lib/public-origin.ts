type Environment = Readonly<Record<string, string | undefined>>;

function parseHttpOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http(s) origin.`);
  }

  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  const isOriginOnly =
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash;
  if (!isHttp || !isOriginOnly) {
    throw new Error(
      `${name} must be an http(s) origin without a path, query, fragment, or credentials.`,
    );
  }

  return url.origin;
}

export function resolvePublicOrigin(
  requestOrigin: string,
  env: Environment = process.env,
): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return parseHttpOrigin("PUBLIC_BASE_URL", configured);
  }

  const productionHostname = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionHostname) {
    return parseHttpOrigin(
      "VERCEL_PROJECT_PRODUCTION_URL",
      `https://${productionHostname}`,
    );
  }

  return parseHttpOrigin("request origin", requestOrigin);
}
