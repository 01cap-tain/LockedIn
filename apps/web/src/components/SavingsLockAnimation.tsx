import { useEffect, useState } from "react";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";

const SAVINGS_LOCK_ANIMATION =
  "https://lottie.host/5c056c8c-e642-4ee1-8f67-2a6e838ddd8a/5hbOTsNLOj.lottie";

/** Deposit holds at 0.5s; withdrawal plays the complete lock/unlock sequence. */
export function SavingsLockAnimation({ mode }: { mode: "deposit" | "withdrawal" }) {
  const [player, setPlayer] = useState<DotLottie | null>(null);

  useEffect(() => {
    if (!player) return;
    const playSegment = () => {
      if (player.totalFrames <= 1 || player.duration <= 0) return;
      const lastFrame = mode === "deposit"
        ? Math.max(1, Math.min(player.totalFrames - 1, Math.round((.5 / player.duration) * player.totalFrames)))
        : player.totalFrames - 1;
      player.setSegment(0, lastFrame);
      player.play();
    };
    player.addEventListener("load", playSegment);
    if (player.isLoaded) playSegment();
    return () => player.removeEventListener("load", playSegment);
  }, [mode, player]);

  return (
    <div className="savings-lock-animation" aria-hidden="true">
      <DotLottieReact autoplay={false} dotLottieRefCallback={setPlayer} loop={false} src={SAVINGS_LOCK_ANIMATION} />
    </div>
  );
}
