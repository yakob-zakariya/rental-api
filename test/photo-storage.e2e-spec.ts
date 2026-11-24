import { randomUUID } from 'node:crypto';
import { HeadObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { PhotoStorage } from '../src/modules/photos/photo-storage.js';
import { createS3Client } from '../src/modules/photos/s3-client.js';
import { S3PhotoStorage } from '../src/modules/photos/s3-photo-storage.js';
import { TEST_ENV } from './test-env.js';
import { createTestApp } from './utils/create-test-app.js';

// Photo storage against the real local SeaweedFS (spec P1, P5; T3.1). Every test uses its own
// keys, so nothing needs cleaning between tests (global-setup.ts empties the buckets per run).

/** Bytes that a CRC trailer or re-encoding would visibly change: a JPEG header and every byte value. */
const PHOTO = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

describe('photo storage (e2e, T3.1)', () => {
  let app: INestApplication<App>;
  let storage: PhotoStorage;
  const s3 = createS3Client({ ...TEST_ENV, S3_FORCE_PATH_STYLE: true });

  beforeAll(async () => {
    app = await createTestApp();
    storage = app.get(PhotoStorage);
  });

  afterAll(async () => {
    s3.destroy();
    await app.close();
  });

  const newKey = () => `properties/${randomUUID()}/photo.jpg`;
  const stored = async (key = newKey()) => {
    await storage.putPrivate(key, PHOTO, 'image/jpeg');
    return key;
  };
  /** A plain GET, with no credentials: what a phone or a stranger gets. */
  const anonymous = (url: string) => fetch(url);
  const bytes = async (response: Response) =>
    Buffer.from(await response.arrayBuffer());
  const privateUrl = (key: string) =>
    `${TEST_ENV.S3_ENDPOINT}/${TEST_ENV.S3_PRIVATE_BUCKET}/${key}`;

  it('the app gets the S3 implementation', () => {
    expect(storage).toBeInstanceOf(S3PhotoStorage);
  });

  describe('private photos (P5)', () => {
    it('come back byte for byte through a signed link, with their content type', async () => {
      const key = await stored();

      const response = await anonymous(await storage.signedUrl(key));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      // No checksum trailer or anything else added to the file (WHEN_REQUIRED, s3-client.ts).
      expect((await bytes(response)).equals(PHOTO)).toBe(true);
    });

    it('cannot be read without a signed link, neither in the private bucket nor at a public URL', async () => {
      const key = await stored();

      expect((await anonymous(privateUrl(key))).status).toBe(403);
      expect((await anonymous(storage.publicUrl(key))).status).toBe(404);
    });

    it('a signed link stops working when it expires', async () => {
      const key = await stored();
      const url = await storage.signedUrl(key, 1);

      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect((await anonymous(url)).status).toBe(403);
    });

    it('signed links last PHOTO_SIGNED_URL_TTL_SECONDS (15 minutes) by default', async () => {
      const url = new URL(await storage.signedUrl(await stored()));

      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    });

    it('deletePrivate removes a photo; deleting a missing one is not an error', async () => {
      const key = await stored();

      await storage.deletePrivate(key);
      await storage.deletePrivate(key);

      expect((await anonymous(await storage.signedUrl(key))).status).toBe(404);
    });
  });

  describe('publishing (P5)', () => {
    it('publish makes the photo readable by anyone at publicUrl, with a 1-day cache (decided 2026-11-24)', async () => {
      const key = await stored();

      await storage.publish(key);
      const response = await anonymous(storage.publicUrl(key));

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=86400',
      );
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect((await bytes(response)).equals(PHOTO)).toBe(true);
      expect(storage.publicUrl(key)).toBe(
        `${TEST_ENV.S3_PUBLIC_BASE_URL}/${key}`,
      );
    });

    it('publishing twice is harmless', async () => {
      const key = await stored();

      await storage.publish(key);
      await storage.publish(key);

      expect((await anonymous(storage.publicUrl(key))).status).toBe(200);
    });

    it('unpublish removes the public copy but keeps the private one; twice is harmless', async () => {
      const key = await stored();
      await storage.publish(key);

      await storage.unpublish(key);
      await storage.unpublish(key);

      expect((await anonymous(storage.publicUrl(key))).status).toBe(404);
      expect((await anonymous(await storage.signedUrl(key))).status).toBe(200);
    });

    it('a photo that was never stored cannot be published', async () => {
      await expect(storage.publish(newKey())).rejects.toBeInstanceOf(
        S3ServiceException,
      );
    });

    it('private copies keep "Cache-Control: private", so no shared cache keeps them', async () => {
      const key = await stored();

      const head = await s3.send(
        new HeadObjectCommand({ Bucket: TEST_ENV.S3_PRIVATE_BUCKET, Key: key }),
      );

      expect(head.CacheControl).toBe('private');
    });
  });

  it('refuses a key that could escape its folder or leak into a URL', async () => {
    await expect(
      storage.putPrivate('../other/photo.jpg', PHOTO, 'image/jpeg'),
    ).rejects.toThrow('Invalid photo storage key');
    expect(() => storage.publicUrl('a b')).toThrow('Invalid photo storage key');
  });

  it('wrong credentials fail clearly (403), they do not silently succeed', async () => {
    const wrong = new S3PhotoStorage(
      createS3Client({
        ...TEST_ENV,
        S3_FORCE_PATH_STYLE: true,
        S3_SECRET_ACCESS_KEY: 'not-the-secret',
      }),
      {
        ...TEST_ENV,
        PHOTO_SIGNED_URL_TTL_SECONDS: 900,
        PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS: 86400,
      },
    );

    const error = await wrong
      .putPrivate(newKey(), PHOTO, 'image/jpeg')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(S3ServiceException);
    expect((error as S3ServiceException).$metadata.httpStatusCode).toBe(403);
  });
});
