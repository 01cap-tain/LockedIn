import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Signer } from "ethers";
import { Check, Circle, LockKeyhole, ShieldCheck, Sparkles, Trophy, Users } from "lucide-react";

import type { ActivityItem, ExitListingSnapshot, VaultSummary } from "../lib/contracts";
import {
  calculateBoosterQualification,
  enrollInBooster,
  loadBoosterCampaign,
  loadBoosterEntryStatus,
  type BoosterCampaign,
  type BoosterEntry,
} from "../lib/nim-booster";

interface RewardsRouteProps {
  signer: Signer | null;
  nimiqAddress: string | null;
  vaults: VaultSummary[];
  activity: ActivityItem[];
  listings: ExitListingSnapshot[];
  onConnect: () => void;
}

export function RewardsRoute({ signer, nimiqAddress, vaults, activity, listings, onConnect }: RewardsRouteProps) {
  const [campaign, setCampaign] = useState<BoosterCampaign | null>(null);
  const [entry, setEntry] = useState<BoosterEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qualification = useMemo(
    () => calculateBoosterQualification(vaults, activity, listings),
    [vaults, activity, listings]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      loadBoosterCampaign(),
      signer ? signer.getAddress().then(loadBoosterEntryStatus) : Promise.resolve(null),
    ]).then(([nextCampaign, nextEntry]) => {
      if (cancelled) return;
      setCampaign(nextCampaign);
      setEntry(nextEntry);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "The Booster could not be loaded.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [signer]);

  async function joinCampaign(): Promise<void> {
    if (!signer || !nimiqAddress) {
      onConnect();
      return;
    }
    setJoining(true);
    setError(null);
    try {
      setEntry(await enrollInBooster(signer, nimiqAddress));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The Booster entry could not be created.");
    } finally {
      setJoining(false);
    }
  }

  return (
    <section className="route-page booster-page">
      <header className="booster-heading">
        <span className="eyebrow"><Sparkles aria-hidden="true" size={14} strokeWidth={1.5} /> NIM Booster</span>
        <h1>Stay consistent. Earn your place.</h1>
        <p>LockedIn rewards steady saving behaviour—not the largest wallet.</p>
      </header>

      <article className="booster-prize-card">
        <div className="booster-prize-icon"><img alt="" aria-hidden="true" src="/brand/nimiq-hexagon.svg" /></div>
        <div>
          <span>Official LockedIn campaign</span>
          <strong>{campaign ? campaign.totalRewardNim.toLocaleString() : "50,000"} NIM</strong>
          <small>{campaign?.winnerCount ?? 5} winners · {(campaign?.rewardPerWinnerNim ?? 10_000).toLocaleString()} NIM each</small>
        </div>
        <span className="booster-stage">{campaign?.status === "SCORING" ? "Selection" : campaign?.status === "CLOSED" ? "Closed" : "Registration"}</span>
      </article>

      <section className="booster-score-card" aria-label="Your Booster qualification">
        <div className="booster-score-topline">
          <div><span>Live qualification estimate</span><strong>{qualification.score}<small>/100</small></strong></div>
          <div className={`booster-score-ring ${qualification.eligible ? "qualified" : ""}`} style={{ "--booster-score": qualification.score } as CSSProperties}>
            {qualification.eligible ? <Trophy aria-hidden="true" size={22} strokeWidth={1.5} /> : qualification.score}
          </div>
        </div>
        <div className="booster-score-track" aria-hidden="true"><span style={{ width: `${qualification.score}%` }} /></div>
        <p>{qualification.eligible
          ? "You currently meet the campaign rules. Final results are verified from Polygon activity."
          : "Keep building your savings rhythm. Complete every requirement to enter the five-winner selection."}</p>
      </section>

      <section className="booster-requirements">
        <div className="booster-section-heading">
          <div><ShieldCheck aria-hidden="true" size={20} strokeWidth={1.5} /><h2>How to qualify</h2></div>
          <span>{qualification.criteria.filter((criterion) => criterion.met).length}/{qualification.criteria.length}</span>
        </div>
        <div className="booster-checklist">
          {qualification.criteria.map((criterion) => (
            <article className={criterion.met ? "complete" : ""} key={criterion.id}>
              <span className="booster-check-icon">{criterion.met
                ? <Check aria-hidden="true" size={17} strokeWidth={1.5} />
                : <Circle aria-hidden="true" size={17} strokeWidth={1.5} />}</span>
              <div><strong>{criterion.label}</strong><small>{criterion.detail}</small></div>
            </article>
          ))}
        </div>
      </section>

      <section className="booster-selection-note">
        <Users aria-hidden="true" size={21} strokeWidth={1.5} />
        <div><strong>Progress earns entry</strong><p>Everyone who satisfies the rules enters a transparent five-winner selection. One large deposit does not guarantee a place.</p></div>
      </section>

      {error && <div className="booster-error" role="alert">{error}</div>}

      <div className="booster-action-area">
        {entry ? (
          <div className="booster-entry-confirmed" role="status">
            <Check aria-hidden="true" size={20} strokeWidth={1.5} />
            <div><strong>You joined the campaign</strong><small>Your progress is tracked as Polygon activity is confirmed.</small></div>
          </div>
        ) : (
          <button className="primary booster-join-button" disabled={joining || loading || campaign?.status !== "REGISTRATION"} onClick={() => void joinCampaign()} type="button">
            {joining ? "Joining…" : !signer || !nimiqAddress ? "Connect wallets to join" : "Join NIM Booster"}
          </button>
        )}
        <p className="booster-payout-note"><LockKeyhole aria-hidden="true" size={14} strokeWidth={1.5} /> NIM payouts are not active yet. No reward can be claimed until the payment phase is released.</p>
      </div>
    </section>
  );
}
