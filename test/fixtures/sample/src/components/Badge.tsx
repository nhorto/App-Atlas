import type { User } from '../models/user';
import { formatName } from '../lib/format';

export function Badge({ user }: { user: User }) {
  return formatName(user);
}
