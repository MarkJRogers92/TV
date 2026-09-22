import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** User-approved canonical MarkTV logo supplied on 2026-09-21. */
export const APPROVED_CANONICAL_LOGO_SHA256 =
  "403487d8d5690d4cc31c5a2d3a8f45a944d5437557b5f3b2f8812b1487d05f2b";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function completePng(buffer: Buffer) {
  if (buffer.length < pngSignature.length || !buffer.subarray(0, 8).equals(pngSignature))
    return false;
  let offset = 8;
  let sawHeader = false;
  let sawImage = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    if (type === "IHDR") sawHeader = true;
    if (type === "IDAT") sawImage = true;
    if (type === "IEND") return sawHeader && sawImage && length === 0 && end === buffer.length;
    offset = end;
  }
  return false;
}

export function isApprovedCanonicalLogoBuffer(buffer: Buffer) {
  return (
    createHash("sha256").update(buffer).digest("hex") ===
      APPROVED_CANONICAL_LOGO_SHA256 && completePng(buffer)
  );
}

export async function inspectCanonicalLogo(repoRoot = process.cwd()) {
  const expectedFile = "marktv-logo-canonical.png";
  const path = join(repoRoot, "assets", "branding", expectedFile);
  try {
    const buffer = await readFile(path);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== APPROVED_CANONICAL_LOGO_SHA256)
      return { state: "invalid" as const, expectedFile, reason: "UNAPPROVED_LOGO_HASH" };
    if (!completePng(buffer))
      return { state: "invalid" as const, expectedFile, reason: "TRUNCATED_PNG" };
    return { state: "bound" as const, expectedFile, sha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "missing" as const, expectedFile, reason: "CANONICAL_LOGO_MISSING" };
    return { state: "invalid" as const, expectedFile, reason: "CANONICAL_LOGO_UNREADABLE" };
  }
}
