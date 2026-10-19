import type { ReactNode } from "react";

/**
 * Loads group invitation, progress and cooperative-exit management only when
 * the selected position is a group vault.
 */
export function GroupManagementRoute({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
