import { UseGuards } from '@nestjs/common';

import { SessionGuard } from './guards';

/** Shared plumbing, and no kind of check. */
export class Plumbing {}

/** This is the class that decides it. Nothing below mentions a caller again. */
@UseGuards(SessionGuard)
export class SignedIn extends Plumbing {}

/** A link in the chain and nothing else. Dropping it would lose every route below. */
export class Reporting extends SignedIn {}

/** Deliberately open, and a sibling of the locked one. */
export class Anyone extends Plumbing {}
