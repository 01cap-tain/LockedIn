import * as Slider from "@radix-ui/react-slider";
import { CircleCheckBig, LockKeyhole } from "lucide-react";

export function wizardProgressPercent(step: number, totalSteps = 5): number {
  if (totalSteps <= 1) return 100;
  const boundedStep = Math.min(Math.max(0, step), totalSteps - 1);
  return boundedStep === totalSteps - 1
    ? 100
    : (boundedStep / totalSteps) * 100;
}

export function allocationAmounts(goal: number, emergencyPercent: number) {
  const safeGoal = Number.isFinite(goal) ? Math.max(0, goal) : 0;
  const safePercent = Math.min(15, Math.max(10, emergencyPercent));
  const emergencyAmount = safeGoal * safePercent / 100;
  return {
    emergencyAmount,
    lockedAmount: Math.max(0, safeGoal - emergencyAmount),
  };
}

export function personalCreationStepReady(input: {
  step: number;
  target: number;
  contribution: number;
  hasEstimatedMaturity: boolean;
  maturityError: string | null;
}): boolean {
  if (input.step === 0) return input.target > 0;
  if (input.step === 1) return input.contribution > 0;
  if (input.step === 2) return input.hasEstimatedMaturity && !input.maturityError;
  return true;
}

export function nextPersonalCreationStep(step: number, returnToReview: boolean): number {
  return returnToReview ? 4 : Math.min(4, step + 1);
}

export function WizardProgressRing({
  step,
  stepTitle,
  totalSteps = 5,
}: {
  step: number;
  stepTitle: string;
  totalSteps?: number;
}) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const progress = wizardProgressPercent(step, totalSteps);
  const dashOffset = circumference * (1 - progress / 100);

  return (
    <div
      className="wizard-progress-ring"
      role="img"
      aria-label={`Step ${step + 1} of ${totalSteps}: ${stepTitle}`}
    >
      <svg aria-hidden="true" viewBox="0 0 36 36">
        <circle className="wizard-progress-ring-track" cx="18" cy="18" r={radius} />
        <circle
          className="wizard-progress-ring-value"
          cx="18"
          cy="18"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
    </div>
  );
}

export function EmergencyAllocationSlider({
  value,
  goal,
  onChange,
  formatAmount,
}: {
  value: number;
  goal: number;
  onChange: (value: number) => void;
  formatAmount: (value: number) => string;
}) {
  const { emergencyAmount, lockedAmount } = allocationAmounts(goal, value);

  return (
    <div className="allocation-control">
      <div className="allocation-control-heading">
        <span>Emergency allocation</span>
        <strong>{value}%</strong>
      </div>
      <Slider.Root
        aria-label="Emergency allocation percentage"
        className="allocation-slider"
        max={15}
        min={10}
        onValueChange={([nextValue]) => onChange(nextValue ?? value)}
        step={1}
        value={[value]}
      >
        <Slider.Track className="allocation-slider-track">
          <Slider.Range className="allocation-slider-range" />
        </Slider.Track>
        <Slider.Thumb aria-label="Emergency allocation percentage" className="allocation-slider-thumb">
          <span aria-hidden="true" className="allocation-slider-value">{value}%</span>
        </Slider.Thumb>
      </Slider.Root>
      <div className="allocation-slider-endpoints" aria-hidden="true">
        <span>10%</span>
        <span>15%</span>
      </div>
      <div className="allocation-amounts" aria-live="polite">
        <span><strong>{formatAmount(emergencyAmount)} USDT</strong> available</span>
        <span><strong>{formatAmount(lockedAmount)} USDT</strong> locked</span>
      </div>
    </div>
  );
}

export function VaultModePreview() {
  return (
    <fieldset className="mode-picker embedded vault-mode-preview">
      <legend>How should locked savings be held?</legend>
      <button aria-pressed="true" className="active" type="button">
        <strong>Safe <CircleCheckBig aria-hidden="true" size={17} strokeWidth={1.5} /></strong>
        <span>Funds remain in the vault. No yield.</span>
      </button>
      <button aria-disabled="true" className="coming-soon-mode" disabled type="button">
        <strong>Earn <small>COMING SOON</small></strong>
        <span>A future option to earn yield on your savings.</span>
      </button>
    </fieldset>
  );
}

export function PersonalVaultReview({
  rows,
  onEdit,
}: {
  rows: Array<{ label: string; value: string; step: number }>;
  onEdit: (step: number) => void;
}) {
  return (
    <>
      <dl className="creation-review personal-review">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              <span>{row.value}</span>
              <button aria-label={`Edit ${row.label}`} onClick={() => onEdit(row.step)} type="button">Edit</button>
            </dd>
          </div>
        ))}
      </dl>
      <p className="review-trust">
        <LockKeyhole aria-hidden="true" size={17} strokeWidth={1.5} />
        LockedIn cannot withdraw your savings.
      </p>
    </>
  );
}
