import { NestFactory } from '@nestjs/core';

import { NotesModule } from './notes.module';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(NotesModule);
  // The addresses the module guards are written without this, and the addresses the
  // controller opens are written without it too. One line decides both.
  app.setGlobalPrefix('api');
  await app.listen(3000);
}
