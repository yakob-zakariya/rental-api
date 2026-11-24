/**
 * Where listing photos are kept (spec P1, P5). Two buckets, because R2 can make only a whole
 * bucket public (decided 2026-11-24):
 * - private: every photo; the lister and staff see it through short-lived signed links;
 * - public: copies of live listings' photos only, readable by anyone at publicUrl().
 * The callers decide when a photo is published or unpublished (approval, back to review, stale,
 * closed, takedown: T4.2 and the other state changes). An abstract class so Nest can inject it by
 * type and tests can swap it, like SmsSender.
 *
 * Keys are chosen by the caller (T3.2) and must match STORAGE_KEY: they appear in public URLs, so
 * they never carry personal data.
 */
export abstract class PhotoStorage {
  /** Stores a photo (already re-encoded, P2) in the private bucket. Overwrites the same key. */
  abstract putPrivate(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void>;

  /** Deletes a photo from the private bucket. A key that doesn't exist is not an error. */
  abstract deletePrivate(key: string): Promise<void>;

  /** A signed GET link to a private photo, valid for PHOTO_SIGNED_URL_TTL_SECONDS (or `ttl`). */
  abstract signedUrl(key: string, ttlSeconds?: number): Promise<string>;

  /**
   * Copies a private photo to the public bucket, with Cache-Control max-age
   * PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS. Idempotent.
   */
  abstract publish(key: string): Promise<void>;

  /**
   * Removes a photo from the public bucket (the private copy stays). Idempotent. Copies already
   * in phone or CDN caches live on until their max-age runs out (see the spec, P5).
   */
  abstract unpublish(key: string): Promise<void>;

  /** The public URL of a published photo (S3_PUBLIC_BASE_URL + key). */
  abstract publicUrl(key: string): string;
}

/** Lowercase letters, digits, and . _ - / between them; no "..", no leading or trailing slash. */
export const STORAGE_KEY = /^(?!.*\.\.)[a-z0-9]+(?:[a-z0-9._/-]*[a-z0-9])?$/;

export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY.test(key) || key.includes('//'))
    throw new Error(`Invalid photo storage key: ${JSON.stringify(key)}`);
}
