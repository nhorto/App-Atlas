import { Controller, Get, UseGuards } from '@nestjs/common';

import { RealAuthGuard } from './guards';

/**
 * The prefix is a template literal whose value lives in another workspace package, so
 * nothing here can read it. Two controllers in this shape used to produce one door.
 */
@Controller(`${ApiPath.Rest}/metadata/layouts`)
export class LayoutMetadataController {
  @Get(':id')
  @UseGuards(RealAuthGuard)
  findOne() {
    return {};
  }
}

@Controller(`${ApiPath.Rest}/metadata/widgets`)
export class WidgetMetadataController {
  @Get(':id')
  findOne() {
    return {};
  }
}

declare const ApiPath: { Rest: string };
