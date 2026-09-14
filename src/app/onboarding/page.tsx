import { OnboardingForm } from './OnboardingForm';
import { Panel } from '@/components/primitives';

/**
 * PRD §8 screen 5. Onboarding.
 *
 * Reachable by anyone, because §5 wants a visitor to be able to create an
 * account, be assigned a persona, and then appear in the switcher — and the
 * demo world has no login to gate it behind.
 */
export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-3 pt-4">
      <div>
        <h1 className="text-[15px] font-semibold">Join the programme</h1>
        <p className="text-[11.5px] text-ink-muted">
          Create an account and a custodial wallet. The account appears in the persona switcher
          immediately, and this session switches to it.
        </p>
      </div>
      <Panel title="Onboarding" dense>
        <OnboardingForm />
      </Panel>
    </div>
  );
}
