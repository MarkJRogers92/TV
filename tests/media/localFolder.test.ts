import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LocalFolderAdapter } from '../../src/media/localFolder.js';

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
