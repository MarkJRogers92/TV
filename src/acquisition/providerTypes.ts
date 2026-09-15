/**
 * Deliberately small, persist-safe provider locators. Download URLs and
 * credentials are short-lived capabilities and must stay in provider adapters,
 * never in a job, matcher, review record, or database JSON blob.
 */
export type ProviderName = "real-debrid" | "torbox";
export type RemoteItemType = "torrent";

export interface RemoteFile {
  readonly provider: ProviderName;
  readonly itemType: RemoteItemType;
  readonly remoteItemId: string;
  readonly remoteFileId: string;
  readonly originalFilename: string;
  /** A provider-relative display/path locator. Empty is valid. */
  readonly remotePath: string;
  /** Null means the provider did not report a usable byte count. */
  readonly bytes: number | null;
}

export interface RemoteItem {
  readonly provider: ProviderName;
  readonly itemType: RemoteItemType;
  readonly remoteItemId: string;
  readonly originalName: string;
  readonly completedAt: string | null;
  readonly files: readonly RemoteFile[];
}
