import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProviderName } from "../../acquisition/providerTypes.js";
import { ProviderError } from "../../integrations/acquisition/provider.js";
import type {
  IntegrationProjection,
  IntegrationStatus,
  ServerContext,
} from "../context.js";
import { notFound, validationError } from "../errors.js";

const SUPPORTED_PROVIDERS = ["real-debrid", "torbox"] as const satisfies readonly ProviderName[];
const MAX_TOKEN_LENGTH = 4096;

const tokenBodySchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(MAX_TOKEN_LENGTH)
    .refine((value) => value.trim().length > 0, {
      message: "Token must not be blank",
    }),
});

const testBodySchema = z.strictObject({});

const FIXED_MESSAGES: Record<string, string> = {
  NO_TOKEN: "No token saved for this provider. Save a token first.",
  AUTHENTICATION: "Authentication failed. Check the saved token and try again.",
  RATE_LIMITED: "Provider rate limit reached. Try again later.",
  UNAVAILABLE: "Provider is temporarily unavailable. Try again later.",
  UNSUPPORTED_SCHEMA: "Provider response is not supported.",
  PERMANENT: "Provider request was rejected.",
  PROVIDER_ERROR: "Provider test failed. Try again later.",
};

function isSupportedProvider(value: string): value is ProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

function disconnectedStatus(): IntegrationStatus {
  return { connected: false, accountLabel: null, error: null };
}

const MAX_SAFE_LABEL_LENGTH = 64;
const LABEL_SCAN_CAP = 1024;
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const ABSOLUTE_URL_PATTERN = /https?:\/\//i;
const BEARER_MATERIAL_PATTERN = /\bbearer\s+[^\s,;]+/i;
const SECRET_FRAGMENT_PATTERN =
  /[?&#;](token|auth_token|access_token|api_key|apikey|key|signature|sig|expires|x-amz-signature|x-amz-credential|x-amz-security-token)=/i;

function labelDisplayUnsafe(label: string): boolean {
  if (label.length === 0 || label.length > MAX_SAFE_LABEL_LENGTH) return true;
  if (label.trim().length === 0) return true;
  const bounded = label.length > LABEL_SCAN_CAP ? label.slice(0, LABEL_SCAN_CAP) : label;
  if (hasControlChar(bounded)) return true;
  if (ABSOLUTE_URL_PATTERN.test(bounded)) return true;
  if (BEARER_MATERIAL_PATTERN.test(bounded)) return true;
  if (SECRET_FRAGMENT_PATTERN.test(bounded)) return true;
  return false;
}

export function sanitizeAccountLabel(label: unknown, token: string | null): string | null {
  if (typeof label !== "string") return null;
  if (labelDisplayUnsafe(label)) return null;
  if (typeof token === "string" && token.length > 0 && label.includes(token)) return null;
  return label;
}

function toProjection(provider: ProviderName, status: IntegrationStatus | undefined): IntegrationProjection {
  const resolved = status ?? disconnectedStatus();
  const accountLabel =
    typeof resolved.accountLabel === "string" && !labelDisplayUnsafe(resolved.accountLabel)
      ? resolved.accountLabel
      : null;
  return {
    provider,
    connected: resolved.connected,
    accountLabel,
    error: resolved.error ? { code: resolved.error.code, message: resolved.error.message } : null,
  };
}

function providerErrorProjection(code: string): IntegrationStatus {
  const message = FIXED_MESSAGES[code] ?? FIXED_MESSAGES.PROVIDER_ERROR;
  const resolvedCode = FIXED_MESSAGES[code] ? code : "PROVIDER_ERROR";
  return { connected: false, accountLabel: null, error: { code: resolvedCode, message } };
}

function credentialSaveFailureProjection(provider: ProviderName): IntegrationProjection {
  return {
    provider,
    connected: false,
    accountLabel: null,
    error: { code: "PROVIDER_ERROR", message: FIXED_MESSAGES.PROVIDER_ERROR },
  };
}

export async function registerIntegrationRoutes(app: FastifyInstance, context: ServerContext) {
  app.get("/api/v1/integrations", async () => {
    return SUPPORTED_PROVIDERS.map((provider) =>
      toProjection(provider, context.integrationStatus.get(provider)),
    );
  });

  app.put("/api/v1/integrations/:provider/token", async (request, reply) => {
    const params = request.params as { provider: string };
    if (!isSupportedProvider(params.provider)) {
      return notFound(reply, "Provider");
    }
    const provider = params.provider;
    let parsed: z.infer<typeof tokenBodySchema>;
    try {
      parsed = tokenBodySchema.parse(request.body);
    } catch (error) {
      return validationError(reply, error);
    }
    try {
      await context.credentials.set(provider, parsed.token);
    } catch {
      return reply.code(503).send(credentialSaveFailureProjection(provider));
    }
    context.integrationStatus.delete(provider);
    return toProjection(provider, undefined);
  });

  app.post("/api/v1/integrations/:provider/test", async (request, reply) => {
    const params = request.params as { provider: string };
    if (!isSupportedProvider(params.provider)) {
      return notFound(reply, "Provider");
    }
    const provider = params.provider;
    try {
      testBodySchema.parse(request.body ?? {});
    } catch (error) {
      return validationError(reply, error);
    }
    let stored: string | null;
    try {
      stored = await context.credentials.get(provider);
    } catch {
      const generic = providerErrorProjection("PROVIDER_ERROR");
      context.integrationStatus.set(provider, generic);
      return toProjection(provider, generic);
    }
    if (!stored || stored.trim().length === 0) {
      const missing: IntegrationStatus = {
        connected: false,
        accountLabel: null,
        error: { code: "NO_TOKEN", message: FIXED_MESSAGES.NO_TOKEN },
      };
      context.integrationStatus.set(provider, missing);
      return toProjection(provider, missing);
    }
    const implementation = context.providers[provider];
    if (!implementation) {
      return notFound(reply, "Provider");
    }
    try {
      const account = await implementation.testAuthentication(stored);
      const safeLabel = sanitizeAccountLabel(account.label, stored);
      if (safeLabel === null) {
        const mapped = providerErrorProjection("UNSUPPORTED_SCHEMA");
        context.integrationStatus.set(provider, mapped);
        return toProjection(provider, mapped);
      }
      const success: IntegrationStatus = {
        connected: true,
        accountLabel: safeLabel,
        error: null,
      };
      context.integrationStatus.set(provider, success);
      return toProjection(provider, success);
    } catch (error) {
      if (error instanceof ProviderError) {
        const mapped = providerErrorProjection(error.code);
        context.integrationStatus.set(provider, mapped);
        return toProjection(provider, mapped);
      }
      const generic = providerErrorProjection("PROVIDER_ERROR");
      context.integrationStatus.set(provider, generic);
      return toProjection(provider, generic);
    }
  });
}
