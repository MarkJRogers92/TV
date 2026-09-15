const REDACTED = "[REDACTED]";
const REDACTED_URL = "[REDACTED_URL]";
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const RELATIVE_URL_PATTERN = /(?:\/[^\s"'<>?]+)?\?[^\s"'<>]+/g;
const SECRET_PARAMETER_PATTERN = /(^|[?&\s])((?:token|auth_token|access_token|api_key|apikey|key|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token))=([^&#\s,;]+)/gi;
const SECRET_QUERY_KEYS = new Set([
  "token",
  "auth_token",
  "access_token",
  "api_key",
  "apikey",
  "key",
  "signature",
  "sig",
  "expires",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
]);
const SECRET_PROPERTY_PATTERN = /(?:^|[-_])(?:token|auth|authorization|api[-_]?key|password|secret|signature|cookie)(?:$|[-_])/i;
const CAPABILITY_PROPERTY_PATTERN = /^(?:download|download[-_]?url|signed[-_]?url|capability[-_]?url)$/i;

function credentialBearingUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://redaction.invalid");
    if (url.username || url.password) return true;
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function redactText(value: string): string {
  const bearerRedacted = value.replace(BEARER_PATTERN, "Bearer " + REDACTED);
  const absoluteUrlsRedacted = bearerRedacted.replace(URL_PATTERN, (url) => (credentialBearingUrl(url) ? REDACTED_URL : url));
  const relativeUrlsRedacted = absoluteUrlsRedacted.replace(RELATIVE_URL_PATTERN, (url) =>
    credentialBearingUrl(url) ? REDACTED_URL : url,
  );
  return relativeUrlsRedacted.replace(SECRET_PARAMETER_PATTERN, (_match, prefix: string, key: string) =>
    `${prefix}${key}=${REDACTED}`,
  );
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    normalized === "x-api-key" ||
    normalized === "api-key" ||
    SECRET_PROPERTY_PATTERN.test(normalized)
  );
}

function isCapabilityKey(key: string): boolean {
  return CAPABILITY_PROPERTY_PATTERN.test(key);
}

function copyError(error: Error, seen: WeakMap<object, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {
    name: error.name,
    message: redactText(error.message),
  };
  seen.set(error, copy);
  if (error.stack) copy.stack = redactText(error.stack);
  for (const key of Object.keys(error)) {
    copy[key] = isCapabilityKey(key)
      ? REDACTED_URL
      : isSecretKey(key)
        ? REDACTED
        : redactValue((error as Error & Record<string, unknown>)[key], seen);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined && !("cause" in copy)) copy.cause = redactValue(cause, seen);
  return copy;
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (value instanceof Error) return copyError(value, seen);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactValue(item, seen));
    return copy;
  }
  if (value instanceof Date) return new Date(value.getTime());

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, nested] of Object.entries(value)) {
    copy[key] = isCapabilityKey(key) ? REDACTED_URL : isSecretKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return copy;
}

/** Returns a deep, non-mutating copy suitable for logs and API errors. */
export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakMap<object, unknown>());
}

export { REDACTED, REDACTED_URL };
