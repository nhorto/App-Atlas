import { Controller, Get, Post } from '@nestjs/common';

@Controller('billing')
export class BillingController {
  @Get(':id')
  read(): unknown {
    return {};
  }

  @Post()
  create(): unknown {
    return {};
  }
}
