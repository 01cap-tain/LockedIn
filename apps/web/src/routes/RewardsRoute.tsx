/** Explains deterministic epochs without implying an unfunded reward promise. */
export function RewardsRoute() {
  return (
    <section className="route-page">
      <article className="panel narrow-panel">
        <div className="section-title">
          <div>
            <h2>Protocol reward epochs</h2>
            <p>Rewards exist only after protocol revenue funds a finalized epoch.</p>
          </div>
        </div>
        <div className="notice">
          <strong>Deterministic, not guaranteed</strong>
          <span>
            Eligible completed groups are weighted by completed target principal.
            Each group allocation is divided equally among its eligible members;
            undistributed integer dust rolls forward. Selling a position permanently
            disqualifies that member, while an emergency withdrawal does not.
          </span>
        </div>
      </article>
    </section>
  );
}
