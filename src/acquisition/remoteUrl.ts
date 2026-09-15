import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsLookup = (hostname: string) => Promise<readonly string[]>;

export class RemoteUrlError extends Error {
  readonly name = "RemoteUrlError";
}

function ipv4Private(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && octets[2] === 99))) ||
    (a === 192 && b === 175 && octets[2] === 48) || (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224;
}

function embeddedIpv4(address: string): string | undefined {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (normalized.startsWith("2002:")) {
    const sixToFour = normalized.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
    const pieces = sixToFour?.[1]?.padStart(4, "0");
    const next = sixToFour?.[2]?.padStart(4, "0");
    if (pieces && next && /^[0-9a-f]{4}$/.test(pieces + next))
      return [pieces.slice(0, 2), pieces.slice(2), next.slice(0, 2), next.slice(2)].map((part) => String(parseInt(part, 16))).join(".");
  }
  return undefined;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4Private(address);
  if (family !== 6) return false;
  const value = address.toLowerCase();
  if (value.startsWith("2002:")) return false;
  const sixToFour = value.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (sixToFour) {
    const hex = sixToFour[1].padStart(4, "0") + sixToFour[2].padStart(4, "0");
    return !ipv4Private([hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)].map((part) => String(parseInt(part, 16))).join("."));
  }
  const embedded = embeddedIpv4(value);
  if (embedded) return !ipv4Private(embedded);
  // NAT64 carries an IPv4 value in its final 32 bits. Reject the well-known
  // prefixes entirely: accepting one would allow an internal IPv4 target.
  if (/^(?:64:ff9b(?::|$)|64:ff9b:1:)/.test(value)) return false;
  return !(value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("::") ||
    value.startsWith("100:") || value.startsWith("2001:0:") || value.startsWith("2001:2:") ||
    value.startsWith("2001:10:") || value.startsWith("2001:20:") || value.startsWith("3ffe:") ||
    value.startsWith("fc") || value.startsWith("fd") ||
    value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") ||
    value.startsWith("ff") || value.startsWith("2001:db8"));
}

export const systemDnsLookup: DnsLookup = async (hostname) =>
  (await nodeLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export interface ValidatedRemoteUrl {
  readonly url: URL;
  /** Pin this exact result in the request socket lookup callback. */
  readonly address: string;
}

/** Validates a capability URL before each request and never follows redirects. */
export async function validateRemoteUrl(value: string, dnsLookup: DnsLookup = systemDnsLookup): Promise<ValidatedRemoteUrl> {
  let url: URL;
  try { url = new URL(value); } catch { throw new RemoteUrlError("Download URL is invalid"); }
  if (url.protocol !== "https:") throw new RemoteUrlError("Download URL must use HTTPS");
  if (url.username || url.password) throw new RemoteUrlError("Download URL must not contain credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (hostname === "metadata.google.internal" || hostname.endsWith(".metadata.google.internal"))
    throw new RemoteUrlError("Download host is a metadata destination");
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new RemoteUrlError("Download host must resolve only to public addresses");
    return { url, address: hostname };
  }
  const addresses = await dnsLookup(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address)))
    throw new RemoteUrlError("Download host must resolve only to public addresses");
  return { url, address: addresses[0] };
}
