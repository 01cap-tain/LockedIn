import type { ReactNode } from "react";

/** Lazy route boundary for the public position market. */
export function MarketRoute({ children }: { children: ReactNode }) {
  return <section className="route-page market-page">{children}</section>;
}
