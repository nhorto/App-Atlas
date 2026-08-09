import { Controller, Get } from '@nestjs/common';

const API_PREFIX = process.env.API_PREFIX ?? 'api';

// No guard, on purpose. If this ever merges with v1's UsersController it will wear
// v1's SessionGuard and read as protected — the false green #159 is about.
@Controller(`${API_PREFIX}/v2/users`)
export class UsersController {
  @Get('list')
  list() {
    return ['alice', 'bob', 'their-emails@example.com'];
  }
}
