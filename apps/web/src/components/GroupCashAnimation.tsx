import { useEffect, useState } from "react";
import {
  DotLottieReact,
  type DotLottie,
} from "@lottiefiles/dotlottie-react";

const GROUP_CASH_ANIMATION =
  "https://lottie.host/eae2a518-db62-40ec-b2d7-8ffd5aaa22e9/HNfp6KQUQY.lottie";

/** Shared-goal cash animation, intentionally skipping the first two seconds. */
export function GroupCashAnimation() {
  const [player, setPlayer] = useState<DotLottie | null>(null);

  useEffect(() => {
    if (!player) return;

    const startAtTwoSeconds = () => {
      if (player.duration <= 0 || player.totalFrames <= 1) return;
      const startFrame = Math.min(
        player.totalFrames - 1,
        Math.round((2 / player.duration) * player.totalFrames)
      );
      player.setSegment(startFrame, player.totalFrames - 1);
      player.play();
    };

    player.addEventListener("load", startAtTwoSeconds);
    if (player.isLoaded) startAtTwoSeconds();
    return () => player.removeEventListener("load", startAtTwoSeconds);
  }, [player]);

  return (
    <div className="group-cash-animation" aria-hidden="true">
      <DotLottieReact
        autoplay={false}
        dotLottieRefCallback={setPlayer}
        loop
        src={GROUP_CASH_ANIMATION}
      />
    </div>
  );
}
