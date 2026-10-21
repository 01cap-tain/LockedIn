import { DotLottieReact } from "@lottiefiles/dotlottie-react";

const SAVER_LISTING_ANIMATION =
  "https://lottie.host/e7822073-a144-42ed-bcce-697b043140ef/9mULjTCJBH.lottie";

/** Decorative saver moment shown after an early-exit listing is confirmed. */
export function SaverListingAnimation() {
  return (
    <div className="saver-listing-animation" aria-hidden="true">
      <DotLottieReact autoplay loop src={SAVER_LISTING_ANIMATION} />
    </div>
  );
}
