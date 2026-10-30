import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = Symbol('isPublic');

/** Opts a controller or route out of the global JwtAuthGuard and ActiveAccountGuard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
