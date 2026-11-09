import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import "./App.css";

const APP_URL = import.meta.env.VITE_MINI_APP_URL || "";
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL || "";
const X_URL = import.meta.env.VITE_X_URL || "";
const MODEL_URL = "/models/piggybank.glb";

type ScrollProgress = { current: number };

function Brand() {
  return (
    <a className="brand" href="/" aria-label="LockedIn Circle home">
      <img
        src="/brand/lockedin-circle-mark.png"
        alt=""
        aria-hidden="true"
        className="brand-mark"
        width={36}
        height={36}
      />
      <span>
        LockedIn <em>Circle</em>
      </span>
    </a>
  );
}

function AppButton() {
  return APP_URL ? (
    <a
      className="button button-gold"
      href={APP_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      Launch App ↗
    </a>
  ) : (
    <span className="button button-disabled" aria-disabled="true">
      App link pending
    </span>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="/#features">Features</a>
          <a href="/#how-it-works">How It Works</a>
          <a href="/#open-source">Open Source</a>
          <a href="/faq">FAQ</a>
        </nav>
        <div className="header-actions">
          <AppButton />
        </div>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a href="/#features">Features</a>
        <a href="/#how-it-works">How It Works</a>
        <a href="/#open-source">Open Source</a>
        <a href="/faq">FAQ</a>
      </nav>
    </header>
  );
}

class ModelErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Piggy bank 3D model failed to render:", error);
    console.debug("Piggy bank component stack:", info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="status"
          style={{ padding: "2rem", color: "#aaa9a2", textAlign: "center" }}
        >
          3D preview unavailable. The rest of the page is still accessible.
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Normalise downloaded Sketchfab models, whose original scale and origin can
 * vary significantly. Keeping the geometry centred also makes rotation
 * genuinely happen around the model instead of an arbitrary distant origin.
 */
function PiggyModel({ progress }: { progress: ScrollProgress }) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(MODEL_URL);

  const preparedModel = useMemo(() => {
    const clone = scene.clone(true);
    clone.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(clone);

    if (bounds.isEmpty())
      throw new Error("The GLB does not contain visible geometry.");

    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
      throw new Error("The GLB contains invalid geometry dimensions.");
    }

    const wrapper = new THREE.Group();
    clone.position.sub(center);
    wrapper.add(clone);

    return { object: wrapper, scale: 3.8 / maxDimension };
  }, [scene]);

  useEffect(() => {
    console.info("Piggy bank GLB loaded", {
      embeddedAnimationClips: animations.map((clip) => clip.name),
      normalisedScale: preparedModel.scale,
    });
  }, [animations, preparedModel]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const p = Math.max(0, Math.min(progress.current, 1));
    const smoothing = 1 - Math.exp(-3.5 * Math.min(delta, 0.1));
    group.current.rotation.y = THREE.MathUtils.lerp(
      group.current.rotation.y,
      -0.3 + p * Math.PI * 0.85,
      smoothing,
    );
    group.current.rotation.x = THREE.MathUtils.lerp(
      group.current.rotation.x,
      0.05 - p * 0.16,
      smoothing,
    );
  });

  return (
    <group ref={group}>
      <primitive object={preparedModel.object} scale={preparedModel.scale} />
    </group>
  );
}

function ModelLoading() {
  return (
    <div className="model-status" role="status">
      Loading 3D piggy bank…
    </div>
  );
}

function PiggyScene({ progress }: { progress: ScrollProgress }) {
  return (
    <ModelErrorBoundary>
      <Suspense fallback={<ModelLoading />}>
        <div className="model-canvas">
          <Canvas
            camera={{ position: [4, 2.8, 6.8], fov: 42, near: 0.1, far: 100 }}
            dpr={[1, 1.5]}
            gl={{ alpha: true, antialias: true }}
            fallback={
              <div className="model-status">
                3D graphics are unavailable in this browser.
              </div>
            }
          >
            <ambientLight intensity={2.3} />
            <hemisphereLight args={[0xffffff, 0x7e6851, 2]} />
            <directionalLight position={[5, 8, 6]} intensity={3} />
            <directionalLight position={[-5, 2, -4]} intensity={1.5} />
            <Suspense
              fallback={
                <Html
                  center
                  style={{
                    color: "#aaa9a2",
                    whiteSpace: "nowrap",
                    fontSize: "14px",
                  }}
                >
                  Loading 3D model…
                </Html>
              }
            >
              <PiggyModel progress={progress} />
            </Suspense>
          </Canvas>
        </div>
      </Suspense>
    </ModelErrorBoundary>
  );
}

function Hero() {
  const stage = useRef<HTMLElement>(null);
  const progress = useRef(0);

  useEffect(() => {
    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let frame = 0;

    const updateProgress = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!stage.current) return;
        if (reducedMotionQuery.matches) {
          progress.current = 0;
          return;
        }
        const rect = stage.current.getBoundingClientRect();
        const distance = Math.max(rect.height - window.innerHeight, 1);
        progress.current = THREE.MathUtils.clamp(-rect.top / distance, 0, 1);
      });
    };

    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    reducedMotionQuery.addEventListener("change", updateProgress);
    return () => {
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
      reducedMotionQuery.removeEventListener("change", updateProgress);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="hero-stage" ref={stage}>
      <div className="hero-sticky">
        <div className="hero-inner">
          <div className="hero-copy">
            <h1>
              Save with intention.
              <br />
              Stay in control.
              <br />
              Grow together.
            </h1>
            <p>
              Build personal or group savings commitments with transparent
              rules, flexible emergency access, and opportunities to earn.
            </p>
            <div className="hero-actions">
              <AppButton />
              <a href="#how-it-works" className="text-link">
                How It Works ↓
              </a>
            </div>
          </div>
          <div
            className="hero-visual"
            aria-label="Scroll-responsive 3D piggy bank"
          >
            <PiggyScene progress={progress} />
          </div>
        </div>
        <span className="scroll-hint">SCROLL TO EXPLORE ↓</span>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="content-section section-features">
      <div className="section-heading">
        <span className="eyebrow">SAVE YOUR WAY</span>
        <h2>Every goal starts somewhere.</h2>
        <p>
          Whether you are working towards something personal or building a
          shared goal, your commitment deserves clarity.
        </p>
      </div>
      <div className="feature-columns">
        <article>
          <span className="feature-number">01 / PERSONAL</span>
          <h3>Make a promise to your future self.</h3>
          <p>
            Set your target, choose your commitment, and follow your progress at
            your own pace.
          </p>
        </article>
        <article>
          <span className="feature-number">02 / GROUP</span>
          <h3>Some goals are better together.</h3>
          <p>
            Create a circle, make a shared commitment, and work towards a common
            goal with clear rules.
          </p>
        </article>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["01", "Create", "Set a goal or join a circle."],
    ["02", "Contribute", "Build your savings commitment."],
    ["03", "Track", "See how far you have come."],
    ["04", "Complete", "Reach maturity and claim your savings."],
  ];
  return (
    <section id="how-it-works" className="content-section">
      <div className="section-heading centered">
        <span className="eyebrow">HOW IT WORKS</span>
        <h2>Small steps. Meaningful progress.</h2>
        <p>
          A clear journey from your first commitment to reaching your savings
          goal.
        </p>
      </div>
      <div className="steps">
        {steps.map(([number, title, description]) => (
          <div className="step" key={number}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function OpenSource() {
  return (
    <section id="open-source" className="content-section open-source">
      <div>
        <span className="eyebrow">BUILT IN THE OPEN</span>
        <h2>Trust starts with transparency.</h2>
      </div>
      <div>
        <p>
          LockedIn Circle is an open-source project. Explore the code,
          understand how it works, and help improve it.
        </p>
        {GITHUB_URL && (
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link"
          >
            Explore the project on GitHub ↗
          </a>
        )}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <span>© 2026 LockedIn Circle</span>
        <div className="footer-legal">
          <span>Terms of Service</span>
          <span>Privacy Policy</span>
        </div>
        <div className="footer-social">
          {GITHUB_URL && (
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              GitHub ↗
            </a>
          )}
          {X_URL && (
            <a href={X_URL} target="_blank" rel="noopener noreferrer">
              X ↗
            </a>
          )}
        </div>
      </div>
      <div className="footer-wordmark" aria-hidden="true">
        LOCKEDIN CIRCLE
      </div>
      <p className="model-credit">
        3D piggy bank model by Issa, licensed under CC BY.{" "}
        <a
          href="https://sketchfab.com/3d-models/cute-and-clean-piggybank-optional-side-logo-40dd69fd5091499cb4c22dc84afcbe40"
          target="_blank"
          rel="noopener noreferrer"
        >
          Model source ↗
        </a>
      </p>
    </footer>
  );
}

function FAQPage() {
  const questions = [
    [
      "What is LockedIn Circle?",
      "A commitment-based savings application for personal and group goals.",
    ],
    [
      "Can I access savings before maturity?",
      "Emergency allocations can be withdrawn under the applicable rules. Other early exits depend on the available mechanisms and their conditions.",
    ],
    [
      "Is LockedIn Circle open source?",
      "Yes. The project's public source code is available for inspection.",
    ],
    [
      "Is earning guaranteed?",
      "No. Any yield option carries risks, and returns are not guaranteed.",
    ],
  ];
  return (
    <section className="faq-page">
      <span className="eyebrow">HELP & ANSWERS</span>
      <h1>Frequently asked questions.</h1>
      {questions.map(([question, answer]) => (
        <details key={question}>
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      ))}
    </section>
  );
}

function App() {
  const isFAQ = window.location.pathname.replace(/\/$/, "") === "/faq";
  return (
    <>
      <Header />
      <main>
        {isFAQ ? (
          <FAQPage />
        ) : (
          <>
            <Hero />
            <Features />
            <HowItWorks />
            <OpenSource />
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

export default App;
