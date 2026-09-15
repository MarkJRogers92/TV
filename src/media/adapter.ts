import type { MediaItem } from '../domain/models.js';

export type ProbeResult = {
  durationMs: number | null;
  /** Omitted only by legacy injected duration-only scanner probes. */
  hasVideoStream?: boolean;
  reason?: string;
};
export type MediaScanDiagnostic = { code: string; path: string; message: string };
export type MediaScanResult = { items: MediaItem[]; diagnostics: MediaScanDiagnostic[] };

export interface MediaAdapter {
  scan(root: string): Promise<MediaScanResult>;
}
