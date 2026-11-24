import { Injectable, Logger } from '@nestjs/common';

/**
 * The CDN in front of the public bucket. Removing a photo from the bucket doesn't reach copies
 * the CDN already holds (Cache-Control max-age 1 day, P5), so a staff takedown also purges them
 * (decided 2026-11-24). An abstract class so the provider's implementation can replace the
 * do-nothing one without touching callers.
 */
export abstract class PublicCache {
  /** Asks the CDN to forget these public URLs. Best effort: failures are logged, never thrown. */
  abstract purge(urls: readonly string[]): Promise<void>;
}

/**
 * Development and tests: there is no CDN, so nothing to purge; logs what it would purge. The real
 * one (Cloudflare's purge-by-URL, if production is behind Cloudflare) is written when the
 * production storage and CDN are chosen (deployment checklist).
 */
@Injectable()
export class NoPublicCache extends PublicCache {
  private readonly logger = new Logger(NoPublicCache.name);

  purge(urls: readonly string[]): Promise<void> {
    if (urls.length > 0)
      this.logger.log(`No CDN configured: would purge ${urls.length} URL(s)`);
    return Promise.resolve();
  }
}
