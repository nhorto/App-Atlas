import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../guards';

const API_PREFIX = process.env.API_PREFIX ?? 'api';

// The point of this file and its v2 sibling: same class name, different files,
// different guards — and a prefix nothing can read on both.
@Controller(`${API_PREFIX}/v1/users`)
@UseGuards(SessionGuard)
export class UsersController {
  @Get('list')
  list() {
    return ['alice', 'bob'];
  }
}
