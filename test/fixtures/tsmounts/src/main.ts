import { NestFactory } from '@nestjs/core';

import { BillingController } from './billing.controller';

export async function bootstrap(): Promise<void> {
  const nest = await NestFactory.create(BillingController);
  // One line, nowhere near any controller, that renames every route Nest serves.
  nest.setGlobalPrefix('nest-api');
  await nest.listen(3000);
}
