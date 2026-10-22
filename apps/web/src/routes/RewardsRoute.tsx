import { BadgeCheck, Gift, ShieldCheck, Sparkles, Trophy } from "lucide-react";

/** Explains deterministic epochs without implying an unfunded reward promise. */
export function RewardsRoute() {
  return (
    <section className="route-page rewards-companion-page">
      <header className="rewards-hero">
        <span className="reward-hero-icon"><Trophy aria-hidden="true" size={25} /></span>
        <div><span className="eyebrow">Progress deserves recognition</span><h2>Complete together. Celebrate together.</h2><p>Keep your group on track and reach every personal goal before maturity.</p></div>
      </header>
      <div className="reward-milestones" aria-label="Savings milestones">
        {[25, 50, 75, 100].map((value) => <div key={value}><span>{value}%</span><i /><small>{value === 100 ? "Goal complete" : "Savings milestone"}</small></div>)}
      </div>
      <div className="reward-card-grid">
        <article className="reward-card"><BadgeCheck aria-hidden="true" /><div><strong>Finish your personal goal</strong><span>Your own target must be completed before maturity.</span></div></article>
        <article className="reward-card"><Sparkles aria-hidden="true" /><div><strong>Help the whole circle finish</strong><span>Every active member completes independently. One saver cannot complete another saver’s goal.</span></div></article>
        <article className="reward-card"><ShieldCheck aria-hidden="true" /><div><strong>Keep your claim</strong><span>Selling a position removes that saver from reward eligibility.</span></div></article>
      </div>
      <article className="reward-funding-note">
        <Gift aria-hidden="true" size={19} />
        <div><strong>Rewards are never promised in advance</strong><span>A reward becomes claimable only after protocol revenue funds and finalizes an eligible epoch. Emergency withdrawals do not remove eligibility.</span></div>
      </article>
    </section>
  );
}
