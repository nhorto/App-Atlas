import { Controller, Delete, Get } from '@nestjs/common';

import { Reporting } from './base.controllers';

// Two links up the chain, in another file, is the only place either of these routes is
// locked. This file has no auth vocabulary in it at all.
@Controller('reports')
export class ReportsController extends Reporting {
  @Get()
  list(): unknown[] {
    return [];
  }

  @Delete(':id')
  remove(): unknown {
    return {};
  }
}
