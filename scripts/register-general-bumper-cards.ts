#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { MediaItem } from "../src/domain/models.js";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
  values.set(name.slice(2), value);
}
const rootValue = values.get("root");
if (!rootValue) throw new Error("Missing --root");
const root = resolve(rootValue);
const manifestValue = values.get("manifest");
if (!manifestValue) throw new Error("Missing --manifest");
const manifest = JSON.parse(await readFile(resolve(manifestValue), "utf8")) as {
  approval?: string;
  renders?: Array<{
    outputPath: string;
    outputSha256: string;
    role: string;
    airReady: boolean;
    rejectReason: string | null;
    validation?: { profileValid?: boolean };
  }>;
};
if (manifest.approval !== "user-approved-finished-legacy-card-artwork")
  throw new Error("Rendered manifest does not carry the expected user approval");
if (manifest.renders?.length !== 20) throw new Error("Rendered manifest must contain exactly 20 cards");
const hashFile = (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
const rendersByName = new Map(
  manifest.renders.map((render) => [basename(render.outputPath), render]),
);
if (rendersByName.size !== 20) throw new Error("Rendered manifest contains duplicate filenames");
for (const [name, render] of rendersByName) {
  if (!render.validation?.profileValid || !render.outputSha256)
    throw new Error(`Rendered manifest does not validate ${name}`);
  const actualHash = await hashFile(join(root, name));
  if (actualHash !== render.outputSha256) throw new Error(`Installed card hash mismatch: ${name}`);
  const staged = render.role === "interruption";
  if (render.airReady === staged || (staged && render.rejectReason !== "STAGED_INTERRUPTION_DISABLED"))
    throw new Error(`Rendered manifest has inconsistent eligibility for ${name}`);
}
const api = (values.get("api") ?? "http://127.0.0.1:4177").replace(/\/$/u, "");
const catalogResponse = await fetch(`${api}/api/v1/media`);
if (!catalogResponse.ok)
  throw new Error(`Could not snapshot media catalog: ${catalogResponse.status}`);
const catalogBefore = (await catalogResponse.json()) as MediaItem[];
const catalogBeforeById = new Map(catalogBefore.map((item) => [item.id, item]));

const scan = await fetch(`${api}/api/v1/media/scan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ root }),
});
if (!scan.ok) throw new Error(`Media scan failed: ${scan.status} ${await scan.text()}`);
const body = (await scan.json()) as { items?: MediaItem[]; diagnostics?: unknown[] };
const items = body.items ?? [];
const putItem = async (item: MediaItem) => {
  const response = await fetch(`${api}/api/v1/media/${encodeURIComponent(item.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!response.ok) throw new Error(`Could not classify ${item.title}: ${response.status} ${await response.text()}`);
};
const deleteItem = async (item: MediaItem) => {
  const response = await fetch(`${api}/api/v1/media/${encodeURIComponent(item.id)}`, {
    method: "DELETE",
  });
  if (!response.ok)
    throw new Error(`Could not remove newly scanned ${item.title}: ${response.status} ${await response.text()}`);
};
let bumpers = 0;
let stationIds = 0;
try {
  if (items.length !== 20) throw new Error(`Expected exactly 20 rendered cards, found ${items.length}`);
  const scannedNames = items.map((item) => basename(item.path));
  const uniqueScannedNames = new Set(scannedNames);
  if (uniqueScannedNames.size !== items.length)
    throw new Error("Scanned card set contains duplicate filenames");
  const missingNames = [...rendersByName.keys()].filter((name) => !uniqueScannedNames.has(name));
  const extraNames = [...uniqueScannedNames].filter((name) => !rendersByName.has(name));
  if (missingNames.length || extraNames.length)
    throw new Error(
      `Scanned card set does not exactly match manifest; missing=${missingNames.join(",") || "none"}; extra=${extraNames.join(",") || "none"}`,
    );
  for (const item of items) {
    if (!item.path.startsWith(`${root}/`)) throw new Error(`Scan escaped the requested root: ${item.path}`);
    const render = rendersByName.get(basename(item.path))!;
    const kind = render.role === "station-id" ? "station-id" : "bumper";
    const tags = [
      "continuity",
      "visual-only",
      "user-approved-legacy-card",
      ...(render.role === "interruption" ? ["staged-disabled"] : []),
    ];
    await putItem({ ...item, kind, tags });
    if (kind === "bumper") bumpers += 1;
    else stationIds += 1;
  }
} catch (error) {
  const rollbackFailures: string[] = [];
  for (const scanned of [...items].reverse()) {
    try {
      const original = catalogBeforeById.get(scanned.id);
      if (original) await putItem(original);
      else await deleteItem(scanned);
    } catch (rollbackError) {
      rollbackFailures.push(
        `${scanned.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
  }
  if (rollbackFailures.length)
    throw new AggregateError(
      [error, ...rollbackFailures.map((failure) => new Error(failure))],
      "General-card registration failed and catalog rollback was incomplete",
    );
  throw error;
}
console.log(`Registered ${items.length} general cards: ${stationIds} station IDs and ${bumpers} bumpers.`);
