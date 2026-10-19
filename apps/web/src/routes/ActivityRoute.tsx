import type { ReactNode } from "react";

/** Lazy route boundary for wallet-specific settlement and chain history. */
export function ActivityRoute({ children }: { children: ReactNode }) {
  return <section className="route-page">{children}</section>;
}
