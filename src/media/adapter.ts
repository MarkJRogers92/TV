import type { MediaItem } from '../domain/models.js';

export type ProbeResult = { durationMs: number | null; reason?: string };
export type MediaScanDiagnostic = { code: string; path: string; message: string };
export type MediaScanResult = { items: MediaItem[]; diagnostics: MediaScanDiagnostic[] };

export interface MediaAdapter {
  scan(root: string): Promise<MediaScanResult>;
}
