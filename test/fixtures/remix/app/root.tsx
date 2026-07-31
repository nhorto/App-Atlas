import { Outlet } from '@remix-run/react';

/** The shell every page renders inside. It sits outside `routes/`, so it is no door. */
export default function App() {
  return <Outlet />;
}
