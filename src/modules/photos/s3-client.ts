import { S3Client } from '@aws-sdk/client-s3';
import type { EnvironmentVariables } from '../../config/env.validation.js';

export type S3Settings = Pick<
  EnvironmentVariables,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
>;

/**
 * The one way to build an S3 client, for the app and the e2e setup alike, so both talk to storage
 * the same way.
 *
 * Checksums: since December 2024 the AWS SDKs add a CRC32 checksum to every upload by default
 * (WHEN_SUPPORTED). S3-compatible stores don't all handle it: SeaweedFS's docs warn the checksum
 * can end up inside the stored file, and R2 lists CRC32 only for multipart uploads. WHEN_REQUIRED
 * sends checksums only where an operation demands one. The e2e tests check that a photo comes back
 * byte for byte.
 */
export function createS3Client(settings: S3Settings): S3Client {
  return new S3Client({
    endpoint: settings.S3_ENDPOINT,
    region: settings.S3_REGION,
    forcePathStyle: settings.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: settings.S3_ACCESS_KEY_ID,
      secretAccessKey: settings.S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
