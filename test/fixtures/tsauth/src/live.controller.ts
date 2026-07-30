import { Controller, Get } from '@nestjs/common';

import { Anyone } from './base.controllers';

// Declared the same way, in the same shape, with the same amount of auth vocabulary in
// it as the controller above — none. Only the hierarchy separates them.
@Controller('live')
export class LivenessController extends Anyone {
  @Get()
  live(): unknown {
    return { ok: true };
  }
}
