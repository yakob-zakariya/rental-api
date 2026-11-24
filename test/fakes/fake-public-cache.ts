import { PublicCache } from '../../src/modules/photos/public-cache.js';

/** Records what the CDN was asked to forget (T4.2). */
export class FakePublicCache extends PublicCache {
  purged: string[] = [];

  purge(urls: readonly string[]): Promise<void> {
    this.purged.push(...urls);
    return Promise.resolve();
  }
}
