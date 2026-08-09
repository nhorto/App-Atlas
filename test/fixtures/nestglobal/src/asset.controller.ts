import { Controller, Delete } from '@nestjs/common';

const Route = { Asset: 'assets' };

// An unreadable prefix (#153), so this door has no address — and it is exactly as
// behind the global guard as its readable neighbours. The catch-all must reach it.
@Controller(`${Route.Asset}`)
export class AssetController {
  @Delete(':id')
  remove() {
    return { removed: true };
  }
}
