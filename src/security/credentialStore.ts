import type { ProviderName } from "../acquisition/providerTypes.js";

/** Credentials are intentionally kept outside the acquisition database. */
export interface CredentialStore {
  get(provider: ProviderName): Promise<string | null>;
  set(provider: ProviderName, token: string): Promise<void>;
  remove(provider: ProviderName): Promise<void>;
}
