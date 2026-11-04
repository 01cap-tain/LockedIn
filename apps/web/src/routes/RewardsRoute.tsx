/** Rewards remain intentionally unavailable in Safe-only V1. */
export function RewardsRoute() {
  return (
    <section className="route-page rewards-minimal-page">
      <div className="reward-coming-soon" role="status" aria-label="Rewards coming soon">
        <button className="reward-btn reward-btn-large" disabled type="button" aria-label="Rewards unavailable">
          <span className="reward-icon-container" aria-hidden="true">
            <svg className="reward-box-top" viewBox="0 0 60 20"><path d="M2 18H58" /><circle cx="20.5" cy="9.5" r="7" /><circle cx="38.5" cy="9.5" r="7" /></svg>
            <svg className="reward-box-body" viewBox="0 0 58 44"><rect x="4" y="4" width="50" height="36" rx="3" /><path d="M1 29H57M45 20L36 3M21 3L13 20" /></svg>
            <span className="reward-coin" />
          </span>
        </button>
        <span>Coming soon</span>
      </div>
    </section>
  );
}
