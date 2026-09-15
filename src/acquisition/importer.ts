import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, stat, unlink } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { MediaItem } from "../domain/models.js";
import { episodeKey, type AcquisitionJob, type CompletedImport, type WantedEpisode } from "./models.js";
import { assertManagedDirectory, canonicalVideoName, containedPath, managedVideoExtensions, ManagedPathError, type ManagedDirectoryIdentity } from "./paths.js";
import { probeDuration } from "../media/ffprobe.js";
import type { ProbeResult } from "../media/adapter.js";

export class ImportNeedsReviewError extends Error { readonly code = "IMPORT_NEEDS_REVIEW"; constructor(message: string) { super(message); this.name = "ImportNeedsReviewError"; } }
export class ImportVerificationError extends Error { readonly code = "IMPORT_VERIFICATION_FAILED"; constructor(message: string) { super(message); this.name = "ImportVerificationError"; } }
type Probe = (path: string) => Promise<ProbeResult>;
type FileIdentity = { dev: number; ino: number; size: number };

export type VerifiedImportContext = {
  readonly library: string;
  readonly inbox: string;
  /** Captured during managed-path startup; never captured during import recovery. */
  readonly inboxIdentity: ManagedDirectoryIdentity;
  /** Captured during managed-path startup; never captured during import recovery. */
  readonly libraryIdentity: ManagedDirectoryIdentity;
  readonly now: () => Date;
  readonly completedImportFor: (job: AcquisitionJob) => CompletedImport | undefined;
  readonly persistPlacing: (job: AcquisitionJob) => void | Promise<void>;
  readonly needsReview: (job: AcquisitionJob, message: string) => void | Promise<void>;
  /** Marks the instant a verified final path has been published without clobbering. */
  readonly publicationCommitted?: () => void | Promise<void>;
  /** Coordinator-owned cancellation; honored until publication commits. */
  readonly signal?: AbortSignal;
  readonly probe?: Probe;
  readonly scan: (root: string) => Promise<{ items: MediaItem[] }>;
  readonly finalize: (media: MediaItem, completedImport: CompletedImport, importedJob: AcquisitionJob) => void | Promise<void>;
};
export type VerifiedImportResult = { media: MediaItem; completedImport: CompletedImport; destinationPath: string; recovered: boolean };

function under(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}
function expectedPart(job: AcquisitionJob, inbox: string): string { return join(resolve(inbox), `${job.id}.part`); }
function expectedBytes(job: AcquisitionJob): number {
  if (job.expectedBytes !== null) return job.expectedBytes;
  if (job.receivedBytes > 0) return job.receivedBytes;
  throw new ImportVerificationError("Completed partial has no positive expected or received byte count");
}
async function fileIdentity(path: string): Promise<FileIdentity> {
  const node = await lstat(path);
  if (!node.isFile() || node.isSymbolicLink()) throw new ImportVerificationError("Managed partial must be a regular non-symlink file");
  return { dev: node.dev, ino: node.ino, size: node.size };
}
async function digestManagedPart(path: string, expected: number): Promise<{ digest: string; identity: FileIdentity }> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new ImportVerificationError(`Cannot safely open managed partial: ${error instanceof Error ? error.message : "unknown error"}`); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected) throw new ImportVerificationError("Partial byte count is incomplete or changed");
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(256 * 1024); let position = 0;
    while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
    const identity = { dev: info.dev, ino: info.ino, size: info.size };
    const now = await fileIdentity(path);
    if (now.dev !== identity.dev || now.ino !== identity.ino || now.size !== identity.size) throw new ImportVerificationError("Managed partial changed while being verified");
    return { digest: hash.digest("hex"), identity };
  } finally { await handle.close(); }
}
async function digestFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(256 * 1024); let position = 0; while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) return hash.digest("hex"); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; } } finally { await handle.close(); }
}
async function assertVerified(path: string, probe: Probe): Promise<void> {
  const result = await probe(path);
  if (!Number.isFinite(result.durationMs) || !result.durationMs || result.durationMs <= 0 || result.hasVideoStream !== true) throw new ImportVerificationError(result.reason ?? "Media has no usable duration and readable video stream");
}
function assertJobWantedIdentity(job: AcquisitionJob, wanted: WantedEpisode): void {
  if (job.wantedId !== wanted.id || job.episodeKey !== episodeKey(wanted.seriesTitle, wanted.season, wanted.episode)) throw new ImportVerificationError("Acquisition job does not match the Wanted episode");
}
async function unlinkProvenPart(path: string, expected: string, bytes: number, hash: string, published?: FileIdentity): Promise<void> {
  if (path !== expected) return;
  try {
    const verified = await digestManagedPart(path, bytes);
    if (verified.digest !== hash || (published && (published.dev !== verified.identity.dev || published.ino !== verified.identity.ino))) return;
    await unlink(path);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Verifies a bound partial and publishes it without clobbering before one caller-owned database finalization transaction. */
export async function importVerifiedEpisode(job: AcquisitionJob, wanted: WantedEpisode, partPath: string, context: VerifiedImportContext): Promise<VerifiedImportResult> {
  let publicationCommitted = false;
  const checkpoint = () => { if (!publicationCommitted) context.signal?.throwIfAborted(); };
  const commitPublication = async () => {
    if (publicationCommitted) return;
    publicationCommitted = true;
    await context.publicationCommitted?.();
  };
  const review = async (message: string): Promise<never> => {
    checkpoint();
    await context.needsReview(job, message);
    checkpoint();
    throw new ImportNeedsReviewError(message);
  };
  const guard = async () => { checkpoint(); await assertManagedDirectory(context.inboxIdentity); checkpoint(); await assertManagedDirectory(context.libraryIdentity); checkpoint(); };
  await guard();
  assertJobWantedIdentity(job, wanted);
  const exactPart = expectedPart(job, context.inbox);
  if (partPath !== exactPart || (job.partPath !== null && job.partPath !== exactPart) || !under(context.inbox, exactPart)) throw new ImportVerificationError("Partial path does not match this managed job");
  const extension = extname(job.originalFilename).toLowerCase();
  if (!managedVideoExtensions.has(extension)) throw new ImportVerificationError("Unsupported video extension");
  const name = canonicalVideoName(wanted.seriesTitle, wanted.season, wanted.episode, wanted.episodeTitle ?? `Episode ${wanted.episode}`, extension);
  const destinationPath = containedPath(context.library, name);
  const probe = context.probe ?? probeDuration;
  const existing = context.completedImportFor(job);
  if (existing) {
    const valid = existing.wantedId === wanted.id && existing.episodeKey === job.episodeKey && existing.provider === job.provider && existing.remoteItemId === job.remoteItemId && existing.remoteFileId === job.remoteFileId && existing.destinationPath === destinationPath && under(context.library, existing.destinationPath);
    if (!valid) return review("Completion ledger does not match this managed import");
    checkpoint();
    const media = (await context.scan(context.library)).items.find((item) => item.id === existing.mediaId && item.path === existing.destinationPath);
    checkpoint();
    if (!media) return review("Completion ledger media record does not match its destination");
    await guard();
    if (job.verifiedSha256 && /^[0-9a-f]{64}$/.test(job.verifiedSha256)) { checkpoint(); await unlinkProvenPart(partPath, exactPart, expectedBytes(job), job.verifiedSha256); checkpoint(); }
    return { media, completedImport: existing, destinationPath, recovered: true };
  }
  let partIdentity: FileIdentity | undefined; let verifiedSha256: string | undefined;
  try {
    const node = await lstat(partPath);
    if (node.isSymbolicLink() || !node.isFile()) throw new ImportVerificationError("Managed partial must be a regular non-symlink file");
    const bytes = expectedBytes(job);
    checkpoint();
    ({ digest: verifiedSha256, identity: partIdentity } = await digestManagedPart(partPath, bytes));
    checkpoint();
    await assertVerified(partPath, probe);
    await guard();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const partPresent = partIdentity !== undefined && verifiedSha256 !== undefined;
  let finalPresent = false;
  try { finalPresent = (await lstat(destinationPath)).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!partPresent && !finalPresent) throw new ImportVerificationError("Neither a completed managed part nor a published destination exists");
  let recovered = false;
  if (!partPresent) {
    if (job.state !== "placing" || job.destinationPath !== destinationPath || !/^[0-9a-f]{64}$/.test(job.verifiedSha256 ?? "")) return review("Final-only recovery lacks verified placing state");
    checkpoint();
    if ((await stat(destinationPath)).size !== expectedBytes(job) || (await digestFile(destinationPath)) !== job.verifiedSha256) return review("Final-only recovery content does not match persisted verification");
    checkpoint(); await assertVerified(destinationPath, probe); checkpoint(); await commitPublication(); recovered = true;
  } else if (finalPresent) {
    checkpoint(); await assertVerified(destinationPath, probe); checkpoint();
    if ((await digestFile(destinationPath)) !== verifiedSha256) return review("Destination already exists with different content");
    await commitPublication(); recovered = true;
  } else {
    const verified = verifiedSha256!;
    const identity = partIdentity!;
    const placing = { ...job, state: "placing" as const, partPath: exactPart, destinationPath, verifiedSha256: verified, updatedAt: context.now().toISOString() };
    await context.persistPlacing(placing);
    checkpoint();
    await guard();
    const current = await fileIdentity(partPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size) throw new ImportVerificationError("Managed partial changed before publication");
    checkpoint();
    try { await link(partPath, destinationPath); await commitPublication(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if ((await digestFile(destinationPath)) !== verified) return review("Destination publication collided with different content"); await commitPublication(); recovered = true; }
    const published = await fileIdentity(destinationPath);
    if (published.dev !== identity.dev || published.ino !== identity.ino || published.size !== identity.size) return review("Published destination did not retain the verified partial inode");
    checkpoint(); await assertVerified(destinationPath, probe); checkpoint();
  }
  const finalHash = await digestFile(destinationPath);
  const expectedHash = partPresent ? verifiedSha256! : job.verifiedSha256!;
  if (finalHash !== expectedHash) return review("Published destination changed after verification");
  await guard();
  checkpoint();
  const scanned = await context.scan(context.library);
  checkpoint();
  const media = scanned.items.find((item) => item.path === destinationPath);
  if (!media) throw new ImportVerificationError("Published file was not registered by the managed library scan");
  if ((await digestFile(destinationPath)) !== expectedHash) return review("Published destination changed before finalization");
  await guard();
  const now = context.now().toISOString();
  const completion: CompletedImport = { id: randomUUID(), wantedId: wanted.id, episodeKey: job.episodeKey, provider: job.provider, remoteItemId: job.remoteItemId, remoteFileId: job.remoteFileId, mediaId: media.id, canonicalName: name, destinationPath, importedAt: now };
  const imported: AcquisitionJob = { ...job, state: "imported", partPath: exactPart, destinationPath, verifiedSha256: partPresent ? verifiedSha256! : job.verifiedSha256 ?? null, updatedAt: now, lastError: null, retryAfterMs: null };
  checkpoint();
  await context.finalize(media, completion, imported);
  checkpoint();
  await guard();
  const publishedIdentity = await fileIdentity(destinationPath);
  checkpoint();
  await unlinkProvenPart(partPath, exactPart, expectedBytes(job), expectedHash, partPresent ? publishedIdentity : undefined);
  checkpoint();
  return { media, completedImport: completion, destinationPath, recovered };
}
export { ManagedPathError };
