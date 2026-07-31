import { Outlet } from '@remix-run/react';

/**
 * A pathless layout: the leading underscore says it wraps other routes without
 * answering at an address of its own. It is not a door, however much it looks like one.
 */
export default function AuthLayout() {
  return (
    <div className="centered">
      <Outlet />
    </div>
  );
}
