import { DotLottieReact } from "@lottiefiles/dotlottie-react";

const COMPLETED_TRADE_ANIMATION =
  "https://lottie.host/c10e8ff0-e471-40f3-88cd-a734d1753ffe/lGOzD3Ax76.lottie";

/** Decorative confirmation shown only after an on-chain trade is finalized. */
export function TradeCompletionAnimation() {
  return (
    <div className="trade-completion-animation" aria-hidden="true">
      <DotLottieReact
        autoplay
        loop={false}
        src={COMPLETED_TRADE_ANIMATION}
      />
    </div>
  );
}
