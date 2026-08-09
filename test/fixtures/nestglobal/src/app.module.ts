import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, EveryoneGuard, MaintenanceGuard } from './guards';
import { AssetController } from './asset.controller';
import { StatusController } from './status.controller';

// One wired through an array variable, the immich spelling; two in the decorator
// directly. Two of the three are checks; EveryoneGuard is the sentinel that is not.
const commonMiddleware = [{ provide: APP_GUARD, useClass: AuthGuard }];

@Module({
  controllers: [StatusController, AssetController],
  providers: [
    ...commonMiddleware,
    { provide: APP_GUARD, useClass: MaintenanceGuard },
    { provide: APP_GUARD, useClass: EveryoneGuard },
  ],
})
export class AppModule {}
