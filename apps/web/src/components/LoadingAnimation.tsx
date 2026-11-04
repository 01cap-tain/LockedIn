/** Decorative lock loader; adjacent live text remains the accessible status. */
export function LoadingAnimation() {
  return (
    <div className="loading-lock" aria-hidden="true">
      <svg width="36" height="40" viewBox="0 0 36 40">
        <path className="loading-lock-body" d="M27 27C27 34.1797 21.1797 40 14 40C6.8203 40 1 34.1797 1 27C1 19.8203 6.8203 14 14 14C21.1797 14 27 19.8203 27 27ZM15.6298 26.5191C16.4544 25.9845 17 25.056 17 24C17 22.3431 15.6569 21 14 21C12.3431 21 11 22.3431 11 24C11 25.056 11.5456 25.9845 12.3702 26.5191L11 32H17L15.6298 26.5191Z" />
        <path className="loading-lock-shackle" d="M6 21V10C6 5.58172 9.58172 2 14 2C18.4183 2 22 5.58172 22 10V21" />
        <path className="loading-lock-bling" d="M29 20L31 22M31.5 15H34.5M29 10L31 8" />
      </svg>
    </div>
  );
}
