import { useEffect, useRef, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CircleDollarSign,
  CirclePlus,
  HandCoins,
  House,
  Plus,
  ShieldCheck,
  Target,
  UserRound,
  UsersRound,
  Vault,
  Wallet,
  WalletCards,
} from "lucide-react";

type OnboardingStep = {
  category: string;
  headline: string;
  description: string;
  illustration: () => ReactNode;
};

function HomeOverviewIllustration() {
  return <div className="guide-illustration guide-home" aria-hidden="true">
    <div className="guide-dashboard-card">
      <span>Total saved</span><strong>2,450 USDT</strong><small>Across 3 savings goals</small>
      <i><b /></i><div><em>68% saved</em><em>Next: 20 USDT Friday</em></div>
    </div>
    <span className="guide-feature-icon"><House size={23} strokeWidth={1.5} /></span>
  </div>;
}

function PlusActionsIllustration() {
  return <div className="guide-illustration guide-plus" aria-hidden="true">
    <span className="guide-plus-centre"><Plus size={27} strokeWidth={1.5} /></span>
    <i className="guide-plus-path path-one" /><i className="guide-plus-path path-two" /><i className="guide-plus-path path-three" />
    <span className="guide-action-tile action-one"><CirclePlus size={18} strokeWidth={1.5} /><b>Add savings</b></span>
    <span className="guide-action-tile action-two"><Target size={18} strokeWidth={1.5} /><b>Create goal</b></span>
    <span className="guide-action-tile action-three"><UsersRound size={18} strokeWidth={1.5} /><b>Start a circle</b></span>
  </div>;
}

function VaultManagementIllustration() {
  return <div className="guide-illustration guide-vault" aria-hidden="true">
    <div className="guide-vault-door"><span /><i /><Vault size={28} strokeWidth={1.4} /></div>
    <div className="guide-vault-cards">
      <span className="personal"><Target size={15} strokeWidth={1.5} /><b>Personal</b></span>
      <span className="group"><UsersRound size={15} strokeWidth={1.5} /><b>Circle</b></span>
      <span className="purchased"><BadgeCheck size={15} strokeWidth={1.5} /><b>Purchased</b></span>
    </div>
    <span className="guide-feature-icon"><Wallet size={23} strokeWidth={1.5} /></span>
  </div>;
}

function EarlyExitIllustration() {
  return <div className="guide-illustration guide-exit" aria-hidden="true">
    <span className="guide-claim"><Vault size={21} strokeWidth={1.5} /><b>Locked claim</b><small>100 USDT</small></span>
    <i className="guide-exit-path"><ArrowRight size={18} strokeWidth={1.5} /></i>
    <span className="guide-exit-market"><HandCoins size={22} strokeWidth={1.5} /><b>Exit</b><small>6.3% discount</small></span>
    <i className="guide-exit-path return"><ArrowLeft size={18} strokeWidth={1.5} /></i>
    <span className="guide-provider"><UserRound size={20} strokeWidth={1.5} /><b>Provider</b></span>
    <span className="guide-payout"><CircleDollarSign size={17} strokeWidth={1.5} /><b>Payout to saver</b></span>
  </div>;
}

function ProfileRhythmIllustration() {
  return <div className="guide-illustration guide-profile" aria-hidden="true">
    <div className="guide-profile-head"><span><UserRound size={20} strokeWidth={1.5} /></span><div><b>Your profile</b><small>0x7B2…91D</small></div><em>6 day streak</em></div>
    <div className="guide-calendar"><b>Saving rhythm</b><span>{[1, 2, 3, 4, 5, 6, 7].map((day) => <i className={day < 6 ? "marked" : ""} key={day}>{day}</i>)}</span></div>
    <div className="guide-wallet-summary"><WalletCards size={18} strokeWidth={1.5} /><span><b>Wallets connected</b><small>Contribution history stays together</small></span></div>
    <span className="guide-feature-icon"><UserRound size={23} strokeWidth={1.5} /></span>
  </div>;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { category: "HOME", headline: "Your savings, in one view.", description: "See what you have saved, how close you are to your goals, and what comes next.", illustration: HomeOverviewIllustration },
  { category: "QUICK ACTIONS", headline: "Start from one place.", description: "Use Plus to add savings, create a personal goal, or begin a circle.", illustration: PlusActionsIllustration },
  { category: "VAULTS", headline: "Every plan has its place.", description: "Open Vaults to manage personal goals, circles and positions you have purchased.", illustration: VaultManagementIllustration },
  { category: "EARLY EXITS", headline: "Plans can change.", description: "Request an early exit or fund another saver’s exit through the market.", illustration: EarlyExitIllustration },
  { category: "YOUR PROFILE", headline: "See the habit you are building.", description: "Follow your contribution history, saving rhythm and connected wallets.", illustration: ProfileRhythmIllustration },
];

export function OnboardingGuide({ step, onStepChange, onFinish }: {
  step: number;
  onStepChange: (step: number) => void;
  onFinish: () => void;
}) {
  const touchStart = useRef<number | null>(null);
  const sheet = useRef<HTMLElement | null>(null);
  const activeStep = ONBOARDING_STEPS[step] ?? ONBOARDING_STEPS[0]!;
  const Illustration = activeStep.illustration;
  const lastStep = step === ONBOARDING_STEPS.length - 1;
  const goBack = () => onStepChange(Math.max(0, step - 1));
  const goForward = () => lastStep ? onFinish() : onStepChange(Math.min(ONBOARDING_STEPS.length - 1, step + 1));

  useEffect(() => { sheet.current?.focus(); }, [step]);

  function handleKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowRight") { event.preventDefault(); goForward(); }
    if (event.key === "ArrowLeft" && step > 0) { event.preventDefault(); goBack(); }
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    touchStart.current = event.changedTouches[0]?.clientX ?? null;
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (touchStart.current === null) return;
    const distance = (event.changedTouches[0]?.clientX ?? touchStart.current) - touchStart.current;
    touchStart.current = null;
    if (Math.abs(distance) < 48) return;
    if (distance < 0) goForward(); else if (step > 0) goBack();
  }

  return <div className="overlay-layer onboarding-layer">
    <button aria-label="Skip onboarding guide" className="overlay-backdrop" onClick={onFinish} type="button" />
    <section
      aria-describedby="onboarding-description"
      aria-labelledby="onboarding-title"
      aria-modal="true"
      className={`onboarding-sheet onboarding-step-${step}`}
      onKeyDown={handleKeyboard}
      onTouchEnd={handleTouchEnd}
      onTouchStart={handleTouchStart}
      ref={sheet}
      role="dialog"
      tabIndex={-1}
    >
      <div className="sheet-grabber" />
      <header className="onboarding-header">
        <div><span className="eyebrow">QUICK GUIDE</span><strong>How LockedIn works</strong><small>Swipe or use Continue to explore each action</small></div>
        <button className="text-action" onClick={onFinish} type="button">Skip</button>
      </header>
      <div className="onboarding-progress" aria-label={`Onboarding step ${step + 1} of ${ONBOARDING_STEPS.length}`}>
        {ONBOARDING_STEPS.map((item, index) => <i className={index <= step ? "active" : ""} key={item.category} />)}
      </div>
      <div aria-live="polite" className="onboarding-stage" key={activeStep.category}>
        <Illustration />
        <div className="onboarding-copy">
          <span className="onboarding-kicker">{activeStep.category}</span>
          <h2 id="onboarding-title">{activeStep.headline}</h2>
          <p id="onboarding-description">{activeStep.description}</p>
        </div>
      </div>
      <footer className="onboarding-actions">
        <button aria-label="Previous onboarding step" className="secondary" disabled={step === 0} onClick={goBack} type="button"><ArrowLeft aria-hidden="true" size={17} strokeWidth={1.5} />Back</button>
        <button className="primary" onClick={goForward} type="button">{lastStep ? "Get started" : "Continue"}{lastStep ? <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.5} /> : <ArrowRight aria-hidden="true" size={17} strokeWidth={1.5} />}</button>
      </footer>
    </section>
  </div>;
}
