import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  decideEmergencyFallback,
  loadVerifiedEmergencyFallbackPool,
  loadVerifiedEmergencyFallbackPoolWithManifestPolicy,
} from "../../src/autopilot/emergencyFallback.js";

const temporaryDirectories: string[] = [];
const manifestVersion = "v1-20260923";

async function makeRoot() {
  const directory = await mkdtemp(join(homedir(), ".marktv-emergency-fallback-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "emergency-assets");
  await mkdir(root);
  return { directory, root: await realpath(root) };
}

function entry(filename: string, bytes: Buffer, source = "/approved/emergency-cards") {
  return {
    filename,
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    validation: "ffprobe metadata and full video/audio decode passed in fixture",
  };
}

async function writeManifest(root: string, assets: unknown[], version = manifestVersion) {
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ version, activated: false, assets }, null, 2),
  );
}

async function planFor(root: string) {
  const pool = await loadTestPolicyPool(root);
  return decideEmergencyFallback({
    externalVolumePresent: false,
    enabledChannels: [{ id: "channel-7" }, { id: "channel-8" }],
    pool,
  });
}

async function loadTestPolicyPool(root: string) {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(root, "manifest.json"));
  } catch {
    return loadVerifiedEmergencyFallbackPool(root);
  }
  return loadVerifiedEmergencyFallbackPoolWithManifestPolicy(root, {
    expectedManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("source-only emergency fallback decision", () => {
  test("plans only hash-matched, full-decode internal assets for enabled channels", async () => {
    const { root } = await makeRoot();
    const technicalDifficulties = Buffer.from("fixture technical difficulties video");
    const moreTelevisionShortly = Buffer.from("fixture more television shortly video");
    const stationId = Buffer.from("fixture one-shot station id video");
    await writeFile(join(root, "technical-difficulties.mp4"), technicalDifficulties);
    await writeFile(join(root, "more-television-shortly.mp4"), moreTelevisionShortly);
    await writeFile(join(root, "marktv-id-primary.mp4"), stationId);
    await writeManifest(root, [
      entry("technical-difficulties.mp4", technicalDifficulties),
      entry("more-television-shortly.mp4", moreTelevisionShortly),
      entry("marktv-id-primary.mp4", stationId, "/approved/station-ids"),
    ]);

    const result = await planFor(root);
    expect(result.status).toBe("fallback-plan-ready");
    expect(result.activation).toBe("not-activated");
    expect(result.channels.map(({ channelId }) => channelId)).toEqual(["channel-7", "channel-8"]);
    expect(result.channels.map(({ action }) => action)).toEqual([
      "internal-emergency-loop",
      "internal-emergency-loop",
    ]);
    expect(result.assetIds).toEqual(["technical-difficulties", "more-television-shortly"]);
    expect(result.preservation).toEqual({
      settingsChanged: false,
      catalogChanged: false,
      historyReset: false,
      externalMountPathCreated: false,
    });
  });

  test("fails closed when the approved manifest or enough current assets are missing", async () => {
    const { root } = await makeRoot();
    expect((await planFor(root)).status).toBe("blocked");

    const onlyAsset = Buffer.from("one current internal asset");
    await writeFile(join(root, "one.mp4"), onlyAsset);
    await writeManifest(root, [entry("one.mp4", onlyAsset), entry("missing.mp4", Buffer.from("missing"))]);
    const result = await planFor(root);
    expect(result.status).toBe("blocked");
    expect(result.channels.map(({ action }) => action)).toEqual(["unavailable", "unavailable"]);
  });

  test("excludes a file changed after the manifest hash was recorded", async () => {
    const { root } = await makeRoot();
    const first = Buffer.from("first approved fixture file");
    const changed = Buffer.from("second approved fixture file");
    await writeFile(join(root, "first.mp4"), first);
    await writeFile(join(root, "changed.mp4"), changed);
    await writeManifest(root, [entry("first.mp4", first), entry("changed.mp4", first)]);

    const result = await planFor(root);
    expect(result.status).toBe("blocked");
    expect(result.assetIds).toEqual([]);
  });

  test("rejects a self-edited manifest that adds a hash-matched asset", async () => {
    const { root } = await makeRoot();
    const first = Buffer.from("first approved manifest asset");
    const added = Buffer.from("asset added after approval");
    await writeFile(join(root, "first.mp4"), first);
    await writeFile(join(root, "added.mp4"), added);
    await writeManifest(root, [entry("first.mp4", first)]);
    const originallyApprovedManifest = await readFile(join(root, "manifest.json"));
    const originalDigest = createHash("sha256").update(originallyApprovedManifest).digest("hex");
    await writeManifest(root, [entry("first.mp4", first), entry("added.mp4", added)]);

    const result = await loadVerifiedEmergencyFallbackPoolWithManifestPolicy(root, {
      expectedManifestSha256: originalDigest,
    });
    expect(result).toEqual({ ok: false, reason: "manifest-invalid" });
    expect(await loadVerifiedEmergencyFallbackPool(root)).toEqual({
      ok: false,
      reason: "manifest-invalid",
    });
  });

  test("rejects symlinked assets and escaped paths", async () => {
    const { directory, root } = await makeRoot();
    const inRoot = Buffer.from("one real fixture file");
    const outside = Buffer.from("outside linked file");
    await writeFile(join(root, "in-root.mp4"), inRoot);
    const outsidePath = join(directory, "outside.mp4");
    await writeFile(outsidePath, outside);
    await symlink(outsidePath, join(root, "linked.mp4"));
    await writeManifest(root, [entry("in-root.mp4", inRoot), entry("linked.mp4", outside)]);

    const result = await planFor(root);
    expect(result.status).toBe("blocked");
    expect(result.assetIds).toEqual([]);

    const rootLink = join(directory, "emergency-assets-link");
    await symlink(root, rootLink);
    expect(await loadVerifiedEmergencyFallbackPoolWithManifestPolicy(rootLink, {
      expectedManifestSha256: "0".repeat(64),
    })).toEqual({ ok: false, reason: "root-not-internal" });
  });

  test("requires the pinned approved manifest version and full-decode evidence", async () => {
    const { root } = await makeRoot();
    const first = Buffer.from("first fixture file");
    const second = Buffer.from("second fixture file");
    await writeFile(join(root, "first.mp4"), first);
    await writeFile(join(root, "second.mp4"), second);
    const metadataOnly = { ...entry("second.mp4", second), validation: "metadata check only" };
    await writeManifest(root, [entry("first.mp4", first), metadataOnly], "unapproved-version");
    expect((await planFor(root)).status).toBe("blocked");

    await writeManifest(root, [entry("first.mp4", first), metadataOnly]);
    expect((await planFor(root)).status).toBe("blocked");
  });

  test("[PL18] does not treat an external-volume root as internal storage", async () => {
    const result = await loadVerifiedEmergencyFallbackPool("/Volumes/SSK Drive /MarkTV/emergency-assets");
    expect(result).toEqual({ ok: false, reason: "root-not-internal" });
  });

  test("rejects a root on a different device from the trusted home anchor when available", async ({ skip }) => {
    const alternateDeviceParent = "/dev/shm";
    try {
      await access(alternateDeviceParent);
    } catch {
      skip();
      return;
    }
    const [homeDevice, alternateDevice] = await Promise.all([
      stat(homedir()).then(({ dev }) => dev),
      stat(alternateDeviceParent).then(({ dev }) => dev),
    ]);
    if (homeDevice === alternateDevice) {
      skip();
      return;
    }
    const root = await mkdtemp(join(alternateDeviceParent, "marktv-emergency-fallback-"));
    temporaryDirectories.push(root);
    const result = await loadVerifiedEmergencyFallbackPool(root);
    expect(result).toEqual({ ok: false, reason: "root-not-internal" });
  });

  test("leaves normal programming alone when the external volume is present", async () => {
    const { root } = await makeRoot();
    const first = Buffer.from("first current internal asset");
    const second = Buffer.from("second current internal asset");
    await writeFile(join(root, "first.mp4"), first);
    await writeFile(join(root, "second.mp4"), second);
    await writeManifest(root, [entry("first.mp4", first), entry("second.mp4", second)]);
    const pool = await loadVerifiedEmergencyFallbackPool(root);
    const result = decideEmergencyFallback({
      externalVolumePresent: true,
      enabledChannels: [{ id: "channel-7" }],
      pool,
    });

    expect(result.status).toBe("no-fallback-needed");
    expect(result.channels).toEqual([{ channelId: "channel-7", action: "normal-programming" }]);
    expect(result.assetIds).toEqual([]);
  });
});
