import { Controller, Get, Post } from '@nestjs/common';

@Controller('status')
export class StatusController {
  @Get('health')
  health() {
    return { ok: true };
  }

  @Post('report')
  report() {
    return { filed: true };
  }
}
