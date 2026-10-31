import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { WebhookService } from './webhook.service.js';

/**
 * Didit → us. Authenticated by the webhook signature, not a token. Not rate-limited, so Didit's
 * retries and bursts always get through. The body is read as received (no DTO): the global
 * ValidationPipe would reject Didit's many fields, and the signature covers the exact payload.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post('didit')
  @HttpCode(HttpStatus.OK)
  async didit(@Req() req: RawBodyRequest<Request>): Promise<void> {
    await this.webhooks.receive({
      headers: req.headers,
      body: req.body as unknown,
      rawBody: req.rawBody,
    });
  }
}
