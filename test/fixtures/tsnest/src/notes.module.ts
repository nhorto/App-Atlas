import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

import { Doorman, Tally } from './doorman';
import { NotesController } from './notes.controller';

@Module({ controllers: [NotesController] })
export class NotesModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    // The addresses are written here and nowhere else. Note the method: `notes` is
    // locked for POST and open for GET, on consecutive lines.
    consumer
      .apply(Doorman)
      .forRoutes(
        { path: 'notes', method: RequestMethod.POST },
        { path: 'notes/:id', method: RequestMethod.DELETE },
      );

    consumer.apply(Tally).forRoutes('notes');
  }
}
