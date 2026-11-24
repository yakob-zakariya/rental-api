import exifr from 'exifr';
import sharp from 'sharp';

// Photos for tests, and tools to inspect what was stored (spec P2).

/** EXIF GPS for Meskel Square (9.0102, 38.7606), in EXIF's degrees/minutes/seconds form. */
export const GPS_EXIF = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '9/1 0/1 3672/100',
  GPSLongitudeRef: 'E',
  GPSLongitude: '38/1 45/1 3816/100',
};

const XMP_WITH_GPS =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="9,0.612N" exif:GPSLongitude="38,45.636E"/>' +
  '</rdf:RDF></x:xmpmeta>';

/** A plain image of the given size and format, with no metadata. */
export const plainImage = (
  width = 64,
  height = 48,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: '#884422' },
  })
    [format]()
    .toBuffer();

/** A JPEG/APPn segment: marker, 2-byte length (counting itself), payload. */
const segment = (marker: number, payload: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
};

/**
 * A JPEG carrying location and identifying data everywhere a phone can put it: EXIF GPS with the
 * phone's make and model and a "rotate 90°" orientation, XMP with GPS, a colour profile (Display
 * P3), an MPF block (where extra images such as depth maps live), an IPTC block with a place name,
 * and a fake motion-photo video after the end of the image. 300 × 200 as stored; upright it is
 * 200 × 300.
 */
export async function jpegWithEverything(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 300, height: 200, channels: 3, background: '#cc3333' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'X1' }, IFD3: GPS_EXIF })
    .withXmp(XMP_WITH_GPS)
    .withIccProfile('p3')
    .toBuffer();
  const mpf = segment(
    0xe2,
    Buffer.concat([Buffer.from('MPF\0'), Buffer.from('extra image index')]),
  );
  const iptc = segment(
    0xed,
    Buffer.from('Photoshop 3.0\0' + '8BIM' + 'Sub-location: Bole, Addis Ababa'),
  );
  const soi = base.subarray(0, 2);
  const video = Buffer.from(
    'ftypmp42 MOTION-PHOTO-VIDEO location=+09.0102+038.7606',
  );
  return Buffer.concat([soi, mpf, iptc, base.subarray(2), video]);
}

/** A PNG or WebP with EXIF GPS (both formats can carry EXIF too). */
export const withGps = (format: 'png' | 'webp'): Promise<Buffer> =>
  sharp({
    create: { width: 64, height: 48, channels: 3, background: '#884422' },
  })
    [format]()
    .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: GPS_EXIF })
    .toBuffer();

/**
 * The GPS position in a file, if any: exifr reads JPEG, PNG, TIFF and HEIC; for WebP (which exifr
 * can't open) the EXIF block is taken out with sharp and read on its own.
 */
export async function gpsIn(
  file: Buffer,
): Promise<{ latitude: number; longitude: number } | undefined> {
  const direct = await exifr.gps(file).catch(() => undefined);
  if (direct) return direct;
  const { exif } = await sharp(file).metadata();
  if (!exif) return undefined;
  const tiff =
    exif.subarray(0, 6).toString('latin1') === 'Exif\0\0'
      ? exif.subarray(6)
      : exif;
  return exifr.gps(tiff).catch(() => undefined);
}

/** The markers of a JPEG's segments before the image data (e.g. 'e1' = APP1, 'db' = tables). */
export function jpegSegmentsBeforeImage(file: Buffer): string[] {
  const markers: string[] = [];
  let i = 2; // after SOI (FF D8)
  while (i < file.length && file[i] === 0xff) {
    const marker = file[i + 1];
    if (marker === 0xda) break; // start of scan: the image data follows
    markers.push(marker.toString(16));
    i += 2 + file.readUInt16BE(i + 2);
  }
  return markers;
}

/**
 * Whether the JPEG ends exactly at its first end-of-image marker after the image data. Inside the
 * compressed data, FF is always followed by 00 or a restart marker, never D9, so the first FF D9
 * is the real end; anything after it (a motion-photo video, say) would show.
 */
export function endsAtEndOfImage(file: Buffer): boolean {
  let sos = 2;
  while (file[sos] === 0xff && file[sos + 1] !== 0xda)
    sos += 2 + file.readUInt16BE(sos + 2);
  const end = file.indexOf(Buffer.from([0xff, 0xd9]), sos);
  return end === file.length - 2;
}
