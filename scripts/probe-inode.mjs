// THROWAWAY diagnostic. Answers, on the real CI filesystem, the questions the
// ManagedDirectoryIdentity analysis rests on. Never intended to be merged.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, lstat, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const say = (...parts) => console.log(...parts);
const inoOf = async (p) => (await lstat(p)).ino;

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (error) {
    say(`  ${label} THREW: ${error?.code ?? error?.message}`);
    return undefined;
  }
}

say("=========== ENVIRONMENT ===========");
say("node          :", process.version);
say("tmpdir        :", os.tmpdir());
say("workspace     :", process.env.GITHUB_WORKSPACE ?? "(unset)");
say("fs.openat     :", typeof fs.openat);
say("O_DIRECTORY   :", fs.constants.O_DIRECTORY);
say("O_NOFOLLOW    :", fs.constants.O_NOFOLLOW);
for (const target of [os.tmpdir(), process.env.GITHUB_WORKSPACE ?? "/"]) {
  await attempt("df", async () => {
    say(`df ${target} :`, execSync(`df -T ${target} 2>/dev/null || df ${target}`).toString().trim().split("\n").join(" | "));
  });
}
await attempt("mount", async () => {
  const mounts = execSync("mount").toString().split("\n").filter((l) => / (\/|\/tmp|.*workspace) /.test(l));
  say("mounts        :", mounts.join(" | ").slice(0, 500));
});

// The scenario the failing test performs, in one place, with and without a pin.
async function roundTrip(parent, holdFd) {
  const dir = join(parent, "inbox");
  await mkdir(dir);
  let fd;
  if (holdFd) fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const before = fd ? fs.fstatSync(fd).ino : await inoOf(dir);
  let rmFailed = null;
  try {
    await rm(dir, { recursive: true });
  } catch (error) {
    rmFailed = error.code ?? error.message;
  }
  let after = null;
  if (!rmFailed) {
    await mkdir(dir);
    after = await inoOf(dir);
  }
  if (fd) {
    // Does the pinned descriptor still refer to the original directory object?
    try { fs.fstatSync(fd); } catch { /* closed */ }
    fs.closeSync(fd);
  }
  return { before, after, rmFailed, reused: after !== null && before === after };
}

async function sweep(label, base, holdFd, iterations) {
  let reused = 0;
  let rmFailed = 0;
  for (let i = 0; i < iterations; i += 1) {
    const parent = await mkdtemp(join(base, "probe-"));
    const result = await roundTrip(parent, holdFd);
    if (result.rmFailed) rmFailed += 1;
    else if (result.reused) reused += 1;
  }
  say(`  ${label}: reuse ${reused}/${iterations}, rm-failed ${rmFailed}/${iterations}`);
  return { reused, rmFailed };
}

say("");
say("=========== SINGLE ROUND TRIP ===========");
for (const [label, holdFd] of [["no fd held", false], ["fd held   ", true]]) {
  const parent = await mkdtemp(join(os.tmpdir(), "probe-single-"));
  const r = await roundTrip(parent, holdFd);
  say(`  ${label}: before=${r.before} after=${r.after} reused=${r.reused} rmError=${r.rmFailed ?? "none"}`);
}

say("");
say("=========== 30 ITERATIONS (tmpdir) ===========");
const tmpNoFd = await sweep("no fd held", os.tmpdir(), false, 30);
const tmpFd = await sweep("fd held   ", os.tmpdir(), true, 30);

say("");
say("=========== 30 ITERATIONS (workspace) ===========");
const ws = process.env.GITHUB_WORKSPACE;
if (ws) {
  await attempt("workspace sweep", async () => {
    await sweep("no fd held", ws, false, 30);
    await sweep("fd held   ", ws, true, 30);
  });
} else {
  say("  skipped: GITHUB_WORKSPACE unset");
}

say("");
say("=========== VERDICT ===========");
say(`inode reuse without a pin (tmpdir)   : ${tmpNoFd.reused}/30`);
say(`inode reuse with a pin   (tmpdir)    : ${tmpFd.reused}/30`);
say(`rmdir blocked by held fd (tmpdir)    : ${tmpFd.rmFailed}/30`);
say("");
say("INTERPRETATION");
say("  reuse-without-pin > 0        => the original CI failure is explained by inode recycling");
say("  reuse-with-pin == 0          => holding an fd prevents recycling, so dev+ino becomes sound");
say("  rm-failed-with-pin > 0       => the kernel refuses the swap outright, which is even stronger");
say("  all zero, no rm failures     => recycling is NOT the cause; the diagnosis needs revisiting");
