import { DotLottieReact } from "@lottiefiles/dotlottie-react";

const LOADING_ANIMATION =
  "https://lottie.host/8de2c1f1-822c-427f-9baf-306ccde56e1a/OP7pBuy2f4.lottie";

/** Decorative loading state; adjacent live text remains the accessible status. */
export function LoadingAnimation() {
  return (
    <div className="loading-lottie" aria-hidden="true">
      <DotLottieReact autoplay loop src={LOADING_ANIMATION} />
    </div>
  );
}
