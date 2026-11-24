import { crc32, deflateSync } from 'node:zlib';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { PhotoStorage } from '../src/modules/photos/photo-storage.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// The photo endpoints (spec P1, P4, L5; T3.2), with the real photo count and storage.

interface Lister {
  token: string;
  userId: string;
}

describe('photos: upload, delete, reorder (e2e, T3.2)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let storage: PhotoStorage;
  const sms = new FakeSmsSender();
  let counter = 0;
  let small: Buffer;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
    storage = app.get(PhotoStorage);
    small = await plainImage(64, 48);
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const lister = async (): Promise<Lister> => {
    const phone = `+2519190000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved' WHERE phone = $1`,
      [phone],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };

  const http = () => request(app.getHttpServer());
  const auth = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });

  /** A complete draft; returns its listing and property ids. */
  const draft = async (who: Lister) => {
    const { body } = await http()
      .post('/listings')
      .set(auth(who))
      .send(fullListing(await boleNeighbourhoodId(db)))
      .expect(201);
    return { id: body.id as string, propertyId: body.property.id as string };
  };
  const upload = (who: Lister, propertyId: string, file: Buffer = small) =>
    http()
      .post(`/properties/${propertyId}/photos`)
      .set(auth(who))
      .attach('photo', file, 'photo.jpg');
  const remove = (who: Lister, propertyId: string, photoId: string) =>
    http().delete(`/properties/${propertyId}/photos/${photoId}`).set(auth(who));
  const reorder = (who: Lister, propertyId: string, photoIds: string[]) =>
    http()
      .put(`/properties/${propertyId}/photos/order`)
      .set(auth(who))
      .send({ photoIds });
  /** A draft with `n` photos; returns ids and the photo ids in order. */
  const withPhotos = async (who: Lister, n: number) => {
    const listing = await draft(who);
    let photos: { id: string }[] = [];
    for (let i = 0; i < n; i++)
      photos = (await upload(who, listing.propertyId).expect(201)).body.property
        .photos;
    return { ...listing, photoIds: photos.map((p) => p.id) };
  };
  const setStatus = (id: string, status: string) =>
    db.query(
      `UPDATE listings SET status = $2::listing_status,
         published_at = CASE WHEN $2::text IN ('live', 'stale', 'expired', 'rented', 'removed') THEN now() END,
         close_reason = CASE $2::text
           WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason
           WHEN 'removed' THEN 'no_longer_for_rent'::listing_close_reason END,
         closed_at = CASE WHEN $2::text IN ('rented', 'removed') THEN now() END
       WHERE id = $1`,
      [id, status],
    );
  const keysOf = async (propertyId: string) =>
    (
      await db.query<{ storage_key: string }[]>(
        `SELECT storage_key FROM property_photos WHERE property_id = $1 ORDER BY position`,
        [propertyId],
      )
    ).map((r) => r.storage_key);

  describe('POST /properties/:id/photos', () => {
    it('adds the photo at the end, stored under a key with no personal data, with a working signed link', async () => {
      const who = await lister();
      const { id, propertyId } = await draft(who);

      const { body } = await upload(who, propertyId).expect(201);

      expect(body).toMatchObject({ id, version: 2 });
      expect(body.property.photos).toEqual([
        expect.objectContaining({ position: 0, width: 64, height: 48 }),
      ]);
      const [key] = await keysOf(propertyId);
      expect(key).toBe(
        `properties/${propertyId}/${body.property.photos[0].id}.jpg`,
      );
      expect((await fetch(body.property.photos[0].url)).status).toBe(200);
    });

    it('P1: at most 12; the 13th is 409 TOO_MANY_PHOTOS and nothing is stored for it', async () => {
      const who = await lister();
      const { propertyId } = await withPhotos(who, 12);

      const { body } = await upload(who, propertyId).expect(409);

      expect(body).toEqual({ code: 'TOO_MANY_PHOTOS', max: 12 });
      expect(await keysOf(propertyId)).toHaveLength(12);
    });

    it('two uploads at the same moment at 11 photos: one is added, one is refused', async () => {
      const who = await lister();
      const { propertyId } = await withPhotos(who, 11);

      const results = await Promise.all([
        upload(who, propertyId),
        upload(who, propertyId),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(await keysOf(propertyId)).toHaveLength(12);
    });

    describe('what a new photo does to the listing (L5)', () => {
      it.each(['draft', 'rejected', 'pending_review'])(
        '%s: stays as it is, version + 1',
        async (status) => {
          const who = await lister();
          const { id, propertyId } = await draft(who);
          await setStatus(id, status);

          const { body } = await upload(who, propertyId).expect(201);

          expect(body).toMatchObject({ status, version: 2 });
        },
      );

      it.each(['live', 'stale'])(
        '%s: back to review, hidden until approved, with a history row',
        async (status) => {
          const who = await lister();
          const { id, propertyId } = await draft(who);
          await setStatus(id, status);

          const { body } = await upload(who, propertyId).expect(201);

          expect(body.status).toBe('pending_review');
          const [last] = await db.query<{ old_status: string }[]>(
            `SELECT old_status FROM listing_history WHERE listing_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [id],
          );
          expect(last.old_status).toBe(status);
        },
      );

      it('expired: stays expired, needsReview set (reopening goes to review)', async () => {
        const who = await lister();
        const { id, propertyId } = await draft(who);
        await setStatus(id, 'expired');

        const { body } = await upload(who, propertyId).expect(201);

        expect(body).toMatchObject({ status: 'expired', needsReview: true });
      });

      it.each(['rented', 'removed'])(
        '%s: 409 INVALID_LISTING_STATE (relist first), nothing stored',
        async (status) => {
          const who = await lister();
          const { id, propertyId } = await draft(who);
          await setStatus(id, status);

          const { body } = await upload(who, propertyId).expect(409);

          expect(body.code).toBe('INVALID_LISTING_STATE');
          expect(await keysOf(propertyId)).toEqual([]);
        },
      );
    });

    it.each([
      ['a GIF', () => tiny().gif().toBuffer()],
      ['a TIFF', () => tiny().tiff().toBuffer()],
      [
        'an SVG',
        async () =>
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
          ),
      ],
      [
        'a PDF',
        async () =>
          Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'),
      ],
      [
        'plain text called photo.jpg',
        async () => Buffer.from('not an image at all'),
      ],
    ] as [string, () => Promise<Buffer>][])(
      'P1: %s is 400 PHOTO_TYPE_NOT_ALLOWED (the type comes from the content, not the name)',
      async (_name, make) => {
        const who = await lister();
        const { propertyId } = await draft(who);

        const { body } = await upload(who, propertyId, await make()).expect(
          400,
        );

        expect(body).toEqual({ code: 'PHOTO_TYPE_NOT_ALLOWED' });
      },
    );

    it('a PNG named photo.jpg is accepted as the PNG it is', async () => {
      const who = await lister();
      const { propertyId } = await draft(who);

      await upload(who, propertyId, await plainImage(64, 48, 'png')).expect(
        201,
      );
    });

    it('a damaged JPEG is 400 PHOTO_UNREADABLE', async () => {
      const who = await lister();
      const { propertyId } = await draft(who);
      const whole = await plainImage(400, 300);

      const { body } = await upload(
        who,
        propertyId,
        whole.subarray(0, Math.floor(whole.length / 2)),
      ).expect(400);

      expect(body).toEqual({ code: 'PHOTO_UNREADABLE' });
    });

    it('a decompression bomb (a tiny file claiming 10000 × 10000 px) is refused before decoding', async () => {
      const who = await lister();
      const { propertyId } = await draft(who);

      const { body } = await upload(
        who,
        propertyId,
        bombPng(10_000, 10_000),
      ).expect(400);

      expect(body).toEqual({ code: 'PHOTO_TOO_MANY_PIXELS', max: 50_000_000 });
    });

    it('over PHOTO_MAX_BYTES (10 MB): 413 PHOTO_TOO_LARGE with the limit', async () => {
      const who = await lister();
      const { propertyId } = await draft(who);
      const tooBig = Buffer.concat([small, Buffer.alloc(10 * 1024 * 1024)]);

      const { body } = await upload(who, propertyId, tooBig).expect(413);

      expect(body).toEqual({ code: 'PHOTO_TOO_LARGE', max: 10485760 });
    });

    it('no file: 400 PHOTO_REQUIRED; another field name or two files: 400 PHOTO_UPLOAD_INVALID', async () => {
      const who = await lister();
      const { propertyId } = await draft(who);
      const url = `/properties/${propertyId}/photos`;

      expect((await http().post(url).set(auth(who)).expect(400)).body).toEqual({
        code: 'PHOTO_REQUIRED',
      });
      expect(
        (
          await http()
            .post(url)
            .set(auth(who))
            .attach('image', small, 'a.jpg')
            .expect(400)
        ).body,
      ).toEqual({ code: 'PHOTO_UPLOAD_INVALID' });
      expect(
        (
          await http()
            .post(url)
            .set(auth(who))
            .attach('photo', small, 'a.jpg')
            .attach('photo', small, 'b.jpg')
            .expect(400)
        ).body,
      ).toEqual({ code: 'PHOTO_UPLOAD_INVALID' });
    });

    it("L3: someone else's property, an unknown id or a malformed id: 404 PROPERTY_NOT_FOUND", async () => {
      const { propertyId } = await draft(await lister());
      const other = await lister();

      for (const target of [
        propertyId,
        '00000000-0000-4000-8000-000000000000',
        'nope',
      ]) {
        const { body } = await upload(other, target).expect(404);
        expect(body.code).toBe('PROPERTY_NOT_FOUND');
      }
      expect(await keysOf(propertyId)).toEqual([]);
    });
  });

  describe('DELETE /properties/:id/photos/:photoId', () => {
    it('removes the photo, moves the later ones up, and deletes the file (private and public copies)', async () => {
      const who = await lister();
      const { propertyId, photoIds } = await withPhotos(who, 3);
      const [, middleKey] = await keysOf(propertyId);
      await storage.publish(middleKey);

      const { body } = await remove(who, propertyId, photoIds[1]).expect(200);

      expect(
        body.property.photos.map((p: { id: string; position: number }) => [
          p.id,
          p.position,
        ]),
      ).toEqual([
        [photoIds[0], 0],
        [photoIds[2], 1],
      ]);
      expect((await fetch(await storage.signedUrl(middleKey))).status).toBe(
        404,
      );
      expect((await fetch(storage.publicUrl(middleKey))).status).toBe(404);
    });

    it.each(['pending_review', 'live', 'stale'])(
      'P4: %s with 3 photos: deleting one is 409 NOT_ENOUGH_PHOTOS (decided 2026-11-24)',
      async (status) => {
        const who = await lister();
        const { id, propertyId, photoIds } = await withPhotos(who, 3);
        await setStatus(id, status);

        const { body } = await remove(who, propertyId, photoIds[0]).expect(409);

        expect(body).toEqual({ code: 'NOT_ENOUGH_PHOTOS', min: 3 });
        expect(await keysOf(propertyId)).toHaveLength(3);
      },
    );

    it.each(['draft', 'rejected', 'expired'])(
      '%s: may go below 3 (submit and reopen check for 3 again)',
      async (status) => {
        const who = await lister();
        const { id, propertyId, photoIds } = await withPhotos(who, 3);
        await setStatus(id, status);

        await remove(who, propertyId, photoIds[0]).expect(200);
      },
    );

    it('live with 4 photos: deleting one sends it back to review', async () => {
      const who = await lister();
      const { id, propertyId, photoIds } = await withPhotos(who, 4);
      await setStatus(id, 'live');

      const { body } = await remove(who, propertyId, photoIds[0]).expect(200);

      expect(body.status).toBe('pending_review');
    });

    it('a photo of another property, or an unknown one: 404 PHOTO_NOT_FOUND', async () => {
      const who = await lister();
      const a = await withPhotos(who, 1);
      const b = await draft(who);

      for (const target of [
        a.photoIds[0],
        '00000000-0000-4000-8000-000000000000',
        'nope',
      ]) {
        const { body } = await remove(who, b.propertyId, target).expect(404);
        expect(body.code).toBe('PHOTO_NOT_FOUND');
      }
    });
  });

  describe('PUT /properties/:id/photos/order', () => {
    it('reorders; on a live listing it applies at once, without review (decided 2026-11-24)', async () => {
      const who = await lister();
      const { id, propertyId, photoIds } = await withPhotos(who, 3);
      await setStatus(id, 'live');
      const reversed = [...photoIds].reverse();

      const { body } = await reorder(who, propertyId, reversed).expect(200);

      expect(body.status).toBe('live');
      expect(body.property.photos.map((p: { id: string }) => p.id)).toEqual(
        reversed,
      );
      expect(body.version).toBe(5); // 3 uploads + the reorder
    });

    it('the same order again changes nothing', async () => {
      const who = await lister();
      const { propertyId, photoIds } = await withPhotos(who, 2);

      const { body } = await reorder(who, propertyId, photoIds).expect(200);

      expect(body.version).toBe(3);
    });

    it.each([
      ['one missing', (ids: string[]) => ids.slice(1)],
      [
        'a stranger',
        (ids: string[]) => [
          ...ids.slice(1),
          '00000000-0000-4000-8000-000000000000',
        ],
      ],
    ])(
      'the list must be exactly the photos (%s): 400 PHOTO_ORDER_MISMATCH',
      async (_name, change) => {
        const who = await lister();
        const { propertyId, photoIds } = await withPhotos(who, 3);

        const { body } = await reorder(
          who,
          propertyId,
          change(photoIds),
        ).expect(400);

        expect(body.code).toBe('PHOTO_ORDER_MISMATCH');
      },
    );

    it('a duplicate id: 400 VALIDATION_FAILED', async () => {
      const who = await lister();
      const { propertyId, photoIds } = await withPhotos(who, 2);

      const { body } = await reorder(who, propertyId, [
        photoIds[0],
        photoIds[0],
      ]).expect(400);

      expect(body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('photos and the rest of the listing', () => {
    it('L2 with real photos: 2 is not enough to submit, 3 is', async () => {
      const who = await lister();
      const { id, propertyId } = await withPhotos(who, 2);

      const refused = await http()
        .post(`/listings/${id}/submit`)
        .set(auth(who))
        .expect(400);
      expect(refused.body).toEqual({ code: 'NOT_ENOUGH_PHOTOS', min: 3 });

      await upload(who, propertyId).expect(201);
      await http().post(`/listings/${id}/submit`).set(auth(who)).expect(200);
    });

    it('GET /me/listings shows the photos in order, with signed links that work', async () => {
      const who = await lister();
      const { photoIds } = await withPhotos(who, 2);

      const { body } = await http()
        .get('/me/listings')
        .set(auth(who))
        .expect(200);

      const photos = body[0].property.photos;
      expect(photos.map((p: { id: string }) => p.id)).toEqual(photoIds);
      for (const photo of photos)
        expect((await fetch(photo.url)).status).toBe(200);
    });

    it('deleting a first draft deletes its photo rows and files', async () => {
      const who = await lister();
      const { id, propertyId } = await withPhotos(who, 2);
      const keys = await keysOf(propertyId);

      await http().delete(`/listings/${id}`).set(auth(who)).expect(204);

      expect(await db.query(`SELECT 1 FROM property_photos`)).toEqual([]);
      for (const key of keys)
        expect((await fetch(await storage.signedUrl(key))).status).toBe(404);
    });

    it('a relisted property keeps its photos; deleting the relist draft keeps them too', async () => {
      const who = await lister();
      const { id, propertyId } = await withPhotos(who, 3);
      await setStatus(id, 'rented');

      const { body: relisted } = await http()
        .post(`/properties/${propertyId}/listings`)
        .set(auth(who))
        .expect(201);
      expect(relisted.property.photos).toHaveLength(3);

      await http()
        .delete(`/listings/${relisted.id}`)
        .set(auth(who))
        .expect(204);
      expect(await keysOf(propertyId)).toHaveLength(3);
    });
  });
});

const tiny = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } });

/**
 * A PNG whose header claims `width` × `height` pixels but holds almost no data: the shape of a
 * decompression bomb. Built by hand (signature, IHDR, a tiny IDAT, IEND) with correct CRCs.
 */
function bombPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
