import { existsSync, readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import exifr from 'exifr';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import {
  endsAtEndOfImage,
  gpsIn,
  jpegSegmentsBeforeImage,
  jpegWithEverything,
  plainImage,
  withGps,
} from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// P2: every upload is re-encoded and no metadata survives, GPS above all, because listing photos
// become public and a GPS tag would reveal the exact location (T3.2). Each test uploads through the
// real endpoint and inspects the file as it was stored, fetched back from storage.

/** A real phone photo with location on, taken in a public place (decided 2026-11-24). */
const PHONE_PHOTO = new URL('./fixtures/phone-photo-gps.jpg', import.meta.url);

/** JPEG segments a stored photo may have: quantisation and Huffman tables, frame headers, restart interval. */
const ALLOWED_SEGMENTS = new Set(['db', 'c4', 'c0', 'c1', 'c2', 'dd']);

describe('photos: no metadata survives (e2e, spec P2)', () => {
  let app: INestApplication<App>;
  const sms = new FakeSmsSender();
  let token: string;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
  });

  beforeEach(async () => {
    ({ accessToken: token } = await signIn(app, sms, '+251919100001'));
    const { body } = await request(app.getHttpServer())
      .post('/listings')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    propertyId = body.property.id;
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Uploads a file and returns the stored photo's bytes, fetched through its signed link. */
  const uploadAndFetch = async (file: Buffer, filename = 'photo.jpg') => {
    const { body } = await request(app.getHttpServer())
      .post(`/properties/${propertyId}/photos`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', file, filename)
      .expect(201);
    const photo = body.property.photos.at(-1);
    const response = await fetch(photo.url);
    expect(response.status).toBe(200);
    return {
      photo,
      stored: Buffer.from(await response.arrayBuffer()),
    };
  };

  /** Every check that the stored file holds pixels only. */
  const expectNoMetadata = async (stored: Buffer) => {
    // An independent EXIF reader finds nothing at all: no GPS, EXIF, XMP, IPTC or colour profile.
    expect(await exifr.gps(stored)).toBeUndefined();
    expect(
      await exifr.parse(stored, {
        tiff: true,
        exif: true,
        gps: true,
        xmp: true,
        iptc: true,
        icc: true,
        jfif: false,
        mergeOutput: false,
      }),
    ).toBeUndefined();
    // sharp agrees.
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: 'jpeg' });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // And the raw bytes: only image tables before the image data (no APP segments of any kind:
    // EXIF, XMP, ICC, MPF, IPTC, maker data), and nothing after the end of the image.
    for (const marker of jpegSegmentsBeforeImage(stored))
      expect(ALLOWED_SEGMENTS).toContain(marker);
    expect(endsAtEndOfImage(stored)).toBe(true);
    const text = stored.toString('latin1');
    for (const trace of [
      'Exif\0\0',
      'http://ns.adobe.com',
      'ICC_PROFILE',
      'MPF\0',
      'Photoshop',
      '8BIM',
      'MOTION',
    ])
      expect(text).not.toContain(trace);
  };

  describe('a real phone photo with location on', () => {
    const fixture = existsSync(PHONE_PHOTO);

    // The user is sending this photo (2026-11-24); until it's in test/fixtures, the test shows as
    // to-do instead of passing without proving anything.
    if (!fixture)
      it.todo(
        'waiting for test/fixtures/phone-photo-gps.jpg (a phone photo with GPS, taken in a public place)',
      );

    it.runIf(fixture)(
      'the original has GPS; the stored photo has no GPS and no metadata at all',
      async () => {
        const original = readFileSync(PHONE_PHOTO);
        // Proves the fixture really holds a location, so the test can't pass by accident.
        const where = await gpsIn(original);
        expect(where?.latitude).toEqual(expect.any(Number));
        expect(where?.longitude).toEqual(expect.any(Number));

        const { stored, photo } = await uploadAndFetch(original);

        await expectNoMetadata(stored);
        expect(Math.max(photo.width, photo.height)).toBeLessThanOrEqual(2048);
      },
    );
  });

  it('a JPEG with location and identifying data everywhere a phone puts it keeps none of it', async () => {
    const original = await jpegWithEverything();
    // The test file really carries all of it.
    expect(await gpsIn(original)).toEqual({
      latitude: expect.closeTo(9.0102, 4),
      longitude: expect.closeTo(38.7606, 4),
    });
    const before = await sharp(original).metadata();
    expect(before.xmp).toBeDefined();
    expect(before.icc).toBeDefined();
    expect(jpegSegmentsBeforeImage(original)).toEqual(
      expect.arrayContaining(['e1', 'e2', 'ed']),
    );
    expect(endsAtEndOfImage(original)).toBe(false);

    const { stored } = await uploadAndFetch(original);

    await expectNoMetadata(stored);
  });

  it.each(['png', 'webp'] as const)(
    'a %s with GPS is stored as a JPEG with no metadata',
    async (format) => {
      const original = await withGps(format);
      expect(await gpsIn(original)).toBeDefined();

      const { stored } = await uploadAndFetch(original, `photo.${format}`);

      await expectNoMetadata(stored);
    },
  );

  it('the photo is turned upright from its EXIF orientation before the metadata goes', async () => {
    // Stored sideways (300 × 200) with "rotate 90°": upright it is 200 × 300.
    const { stored, photo } = await uploadAndFetch(await jpegWithEverything());

    expect(photo).toMatchObject({ width: 200, height: 300 });
    expect(await sharp(stored).metadata()).toMatchObject({
      width: 200,
      height: 300,
    });
  });

  it('a large photo is shrunk to 2048 px on its longest side; a small one is not enlarged', async () => {
    const big = await uploadAndFetch(await plainImage(4000, 3000));
    expect(big.photo).toMatchObject({ width: 2048, height: 1536 });

    const small = await uploadAndFetch(await plainImage(640, 480));
    expect(small.photo).toMatchObject({ width: 640, height: 480 });
  });
});
