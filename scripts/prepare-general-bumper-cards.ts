#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
  values.set(name.slice(2), value);
}
const required = (name: string) => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const source = required("source");
const output = required("out");

function completePng(buffer: Buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    if (type === "IEND") return length === 0 && end === buffer.length;
    offset = end;
  }
  return false;
}

const roleFor = (name: string) => {
  if (name.startsWith("03-")) return "return";
  if (name.startsWith("17-")) return "break";
  if (name.startsWith("09-")) return "interruption";
  return "station-id";
};

const files: string[] = [];
for (const volume of ["volume-1", "volume-2"]) {
  const directory = join(source, volume);
  for (const file of await readdir(directory)) if (file.endsWith(".png")) files.push(join(directory, file));
}
files.sort((left, right) => basename(left).localeCompare(basename(right)));
await mkdir(join(output, "source"), { recursive: true });
const cards = [];
const seen = new Set<string>();
for (const path of files) {
  const buffer = await readFile(path);
  if (!completePng(buffer)) throw new Error(`Invalid or incomplete PNG: ${path}`);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (seen.has(sha256)) continue;
  seen.add(sha256);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const name = basename(path);
  const destination = join(output, "source", `${sha256.slice(0, 16)}-${name}`);
  await copyFile(path, destination, 0x1);
  const role = roleFor(name);
  cards.push({
    id: `general-card:${sha256.slice(0, 16)}`,
    sourceName: name,
    path: destination,
    sha256,
    width,
    height,
    role,
    lifecycle: role === "interruption" ? "quarantined" : "classified",
    airReady: false,
    reason: role === "interruption" ? "STAGED_INTERRUPTION_DISABLED" : "STILL_REQUIRES_RENDER",
    brandingNote: "User-supplied finished card; embedded wordmark is not the canonical logo binding",
  });
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceApproval: "user-supplied-local-artwork",
  uniqueCards: cards.length,
  productionEligible: 0,
  cards,
};
const destination = join(output, "manifest.json");
const temporary = `${destination}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
await rename(temporary, destination);
console.log(`Prepared ${cards.length} unique general-bumper source cards. Air ready: 0.`);
