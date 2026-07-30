import { Controller, Delete, Get, Post } from '@nestjs/common';

// Four doors, two of them locked, and this file says nothing about any of it.
@Controller()
export class NotesController {
  @Get('notes')
  list(): unknown[] {
    return [];
  }

  @Post('notes')
  create(): unknown {
    return {};
  }

  @Get('notes/:id')
  read(): unknown {
    return {};
  }

  @Delete('notes/:id')
  remove(): unknown {
    return {};
  }
}
