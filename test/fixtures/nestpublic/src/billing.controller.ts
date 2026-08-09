import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { PublicApiKeyGuard, PublicEndpointGuard, RealAuthGuard } from './guards';

@Controller('billing')
export class BillingController {
  @Get('health')
  @UseGuards(PublicEndpointGuard)
  health() {
    return 'ok';
  }

  @Get('invoices')
  @UseGuards(RealAuthGuard)
  invoices() {
    return [];
  }

  @Post('webhook')
  @UseGuards(PublicApiKeyGuard)
  webhook() {
    return 'ok';
  }

  @Post('charge')
  charge() {
    return 'ok';
  }
}
