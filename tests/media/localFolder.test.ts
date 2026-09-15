import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LocalFolderAdapter } from '../../src/media/localFolder.js';
import { canonicalVideoName } from '../../src/acquisition/paths.js';
import { parseVideoCandidate, videoExtensions } from '../../src/acquisition/filename.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories.js';
import { registerManagedLibrary } from '../../src/media/roots.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixtureTree() {
  const root = await mkdtemp(`${tmpdir()}/marktv-media-`);
  directories.push(root);
  await mkdir(join(root, 'Comedy Show', 'Season 01'), { recursive: true });
  await mkdir(join(root, 'Movies'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  const files = [
    join(root, 'Comedy Show', 'Season 01', 'Comedy_Show_S01E02.MP4'),
    join(root, 'Movies', 'Wacky_Weekend_2024.mkv'),
    join(root, 'clip.m4v'),
    join(root, 'clip.mov'),
    join(root, 'clip.avi'),
    join(root, 'clip.webm'),
    join(root, 'ignore.txt'),
    join(root, '.hidden.mp4'),
    join(root, '.hidden', 'also-hidden.mp4'),
  ];
  await Promise.all(files.map((path) => writeFile(path, 'fixture')));
  await symlink(files[0], join(root, 'linked.mp4'));
  return root;
}

async function snapshot(root: string) {
  const paths = (await readdir(root, { recursive: true })).map(String).sort();
  return Promise.all(paths.map(async (path) => {
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    return { path, type: stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file', size: stats.size, content: stats.isFile() ? await readFile(absolute, 'utf8') : undefined };
  }));
}

test('discovers supported extensions while ignoring hidden paths and symlinks without modifying the tree', async () => {
  const root = await fixtureTree();
  const before = await snapshot(root);
  const adapter = new LocalFolderAdapter(async () => ({ durationMs: 60_000 }));
  const result = await adapter.scan(root);

  expect(result.items).toHaveLength(6);
  expect(result.items.map((entry) => entry.path)).not.toEqual(expect.arrayContaining([
    expect.stringContaining('.hidden'),
    expect.stringContaining('linked.mp4'),
  ]));
  expect(await snapshot(root)).toEqual(before);
});

test('extracts SxxEyy hints and records a missing injected ffprobe duration', async () => {
  const root = await fixtureTree();
  const probe = vi.fn(async (path: string) => path.endsWith('.MP4') ? { durationMs: 1_380_000 } : { durationMs: null, reason: 'ffprobe unavailable' });
  const result = await new LocalFolderAdapter(probe).scan(root);
  const episode = result.items.find((entry) => entry.path?.endsWith('.MP4'));

  expect(probe.mock.calls.every(([path]) => path.startsWith('/'))).toBe(true);
  expect(episode).toMatchObject({ season: 1, episode: 2, durationMs: 1_380_000, durationStatus: 'ok' });
  expect(result.items.find((entry) => entry.path?.endsWith('.mkv'))).toMatchObject({ kind: 'movie', durationMs: null, durationStatus: 'missing', available: false });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: 'ffprobe unavailable' }));
});

test('turns probe failures into item diagnostics instead of aborting the scan', async () => {
  const root = await fixtureTree();
  const result = await new LocalFolderAdapter(async () => { throw new Error('probe crashed'); }).scan(root);
  expect(result.items).toHaveLength(6);
  expect(result.items.every((entry) => entry.durationStatus === 'missing')).toBe(true);
  expect(result.diagnostics[0].message).toContain('probe crashed');
});

test('uses canonical acquisition names as authoritative episode metadata on rescan', async () => {
  const root = await mkdtemp(`${tmpdir()}/marktv-canonical-`);
  directories.push(root);
  await writeFile(join(root, 'Series Name - S03E04 - Episode Title.mkv'), 'fixture');
  const result = await new LocalFolderAdapter(async () => ({ durationMs: 1_000 })).scan(root);
  expect(result.items).toEqual([
    expect.objectContaining({
      kind: 'episode', showTitle: 'Series Name', title: 'Episode Title', season: 3, episode: 4,
    }),
  ]);
});

test('keeps legitimate Trailer, Extras, and Featurette episode titles on canonical rescan', async () => {
  const root = await mkdtemp(`${tmpdir()}/marktv-canonical-`);
  directories.push(root);
  await Promise.all(['Trailer', 'Extras', 'Featurette'].map((title, index) =>
    writeFile(join(root, `Series Name - S03E0${index + 1} - ${title}.mkv`), 'fixture')));
  const result = await new LocalFolderAdapter(async () => ({ durationMs: 1_000 })).scan(root);
  expect(result.items.map((item) => item.title).sort()).toEqual(['Extras', 'Featurette', 'Trailer']);
});

test('preserves multi-word extras-style managed titles with season and episode metadata', async () => {
  const root = await mkdtemp(`${tmpdir()}/marktv-canonical-`);
  directories.push(root);
  await writeFile(join(root, 'Severance - S03E04 - Deleted Extras and Featurette.mkv'), 'fixture');
  const result = await new LocalFolderAdapter(async () => ({ durationMs: 1_000 })).scan(root);
  expect(result.items).toEqual([
    expect.objectContaining({
      kind: 'episode', showTitle: 'Severance', title: 'Deleted Extras and Featurette', season: 3, episode: 4,
    }),
  ]);
});

test('shares one video-extension allowlist across matching, canonical naming, and scanning', async () => {
  const root = await mkdtemp(`${tmpdir()}/marktv-extensions-`);
  directories.push(root);
  const selectableNames = videoExtensions.map((extension) =>
    canonicalVideoName('Series Name', 3, 4, 'Episode Title', `.${extension}`),
  );
  await Promise.all(selectableNames.map((name) => writeFile(join(root, name), 'fixture')));
  const unsupportedName = 'Series Name - S03E04 - Episode Title.ts';
  await writeFile(join(root, unsupportedName), 'fixture');

  const remoteFile = (name: string) => ({
    provider: 'torbox' as const,
    itemType: 'torrent' as const,
    remoteItemId: 'item-1',
    remoteFileId: `file-${name}`,
    originalFilename: name,
    remotePath: name,
    bytes: 1_000,
  });

  expect(videoExtensions).not.toContain('ts');
  for (const name of selectableNames) {
    expect(parseVideoCandidate(remoteFile(name))).toMatchObject({
      seriesTitle: 'Series Name',
      episodeTitle: 'Episode Title',
      season: 3,
      episode: 4,
    });
  }
  expect(parseVideoCandidate(remoteFile(unsupportedName))).toBeNull();
  expect(() =>
    canonicalVideoName('Series Name', 3, 4, 'Episode Title', '.ts'),
  ).toThrow(/unsupported video extension/i);

  const result = await new LocalFolderAdapter(async () => ({ durationMs: 1_000 })).scan(root);
  expect(result.items).toHaveLength(selectableNames.length);
  const scannedNames = result.items.map((item) => item.path ? basename(item.path) : '').sort();
  expect(scannedNames).toEqual([...selectableNames].sort());
  expect(scannedNames).not.toContain(unsupportedName);
});

test('does not make a production probe with no readable video stream available', async () => {
  const root = await fixtureTree();
  const result = await new LocalFolderAdapter(async () => ({ durationMs: 10_000, hasVideoStream: false, reason: 'no video' })).scan(root);
  expect(result.items.every((item) => item.available === false && item.durationMs === null)).toBe(true);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: 'no video' }));
});

test('registers the owner-only managed library exactly once', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/marktv-managed-`);
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  const first = await registerManagedLibrary(repositories, dataDir);
  const second = await registerManagedLibrary(repositories, dataDir);
  expect(first.root).toEqual(second.root);
  expect(repositories.settings.list().filter((entry) => entry.id.startsWith('media-root:'))).toHaveLength(1);
  repositories.close();
});

test('rejects relative, missing, file, and symlink scan roots with stable errors', async () => {
  const root = await fixtureTree();
  const file = join(root, 'ignore.txt');
  const link = join(root, 'root-link');
  await symlink(join(root, 'Movies'), link);
  const adapter = new LocalFolderAdapter(async () => ({ durationMs: 60_000 }));

  await expect(adapter.scan('relative')).rejects.toMatchObject({ code: 'INVALID_SCAN_ROOT' });
  await expect(adapter.scan(resolve(root, 'missing'))).rejects.toMatchObject({ code: 'SCAN_ROOT_NOT_FOUND' });
  await expect(adapter.scan(file)).rejects.toMatchObject({ code: 'SCAN_ROOT_NOT_DIRECTORY' });
  await expect(adapter.scan(link)).rejects.toMatchObject({ code: 'SCAN_ROOT_SYMLINK' });
});
