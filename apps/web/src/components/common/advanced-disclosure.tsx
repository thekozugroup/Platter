import { useAdvancedMode } from '@/lib/advanced-mode';
import { cn } from '@/lib/utils';

/**
 * Content that only exists in advanced mode.
 *
 * The app defaults to easy mode, so this renders nothing at all rather than a collapsed
 * disclosure — a row of "Advanced" buttons on every screen is the clutter easy mode is meant
 * to remove, and re-opening them on each visit is worse than a single global switch.
 *
 * `force` is the safety valve, and it matters more than the feature does. Anything a person
 * has to act on — a field that failed validation, a setting already moved off its default —
 * must be visible whichever mode they are in. An invisible error is a user stuck with no idea
 * why, and no reason to suspect a preference is the cause.
 */

export interface AdvancedOnlyProps {
  children: React.ReactNode;
  /** Renders regardless of mode. For errors and non-default values that must not be hidden. */
  force?: boolean;
  /** Supplying one wraps the children in a div; without it they render bare. */
  className?: string;
}

export function AdvancedOnly({ children, force = false, className }: AdvancedOnlyProps) {
  const { advanced } = useAdvancedMode();
  if (!advanced && !force) return null;

  /*
   * No wrapper unless one is asked for. This gates a phrase inside a paragraph as often as it
   * gates a card, and an unconditional <div> would be invalid DOM in the first case — the
   * component should not decide the layout of something it only decides the visibility of.
   */
  if (className === undefined) return <>{children}</>;
  return <div className={className}>{children}</div>;
}

/**
 * Content that exists only in easy mode — the simpler half of a pair.
 *
 * Gating is only honest when something stands in for what was removed. Used with
 * `AdvancedOnly` around the same idea, this is how a screen offers three presets to a
 * beginner and the full matrix to everyone else, rather than offering the matrix to one and
 * a hole to the other.
 */
export function EasyOnly({ children, className }: Omit<AdvancedOnlyProps, 'force'>) {
  const { advanced } = useAdvancedMode();
  if (advanced) return null;
  if (className === undefined) return <>{children}</>;
  return <div className={className}>{children}</div>;
}

export interface AdvancedHintProps {
  /** What is behind the switch, named: "the raw cron expression", "every port". */
  hidden: string;
  className?: string;
}

/**
 * Says what easy mode is holding back, and offers the way to it.
 *
 * Without this, hiding a control and never having built it are the same experience. Someone
 * who cannot find the port table has no reason to suspect a preference is the cause — and
 * the preference lives in the account menu, which is the last place anybody looks for a
 * missing setting. One line, at the point of absence, costs almost nothing and is the
 * difference between a mode and a missing feature.
 */
export function AdvancedHint({ hidden, className }: AdvancedHintProps) {
  const { advanced, setAdvanced } = useAdvancedMode();
  if (advanced) return null;

  return (
    <p className={cn('text-caption text-label-tertiary', className)}>
      {hidden}{' '}
      <button
        className="rounded-xs underline underline-offset-2 hover:text-label-secondary"
        onClick={() => setAdvanced(true)}
        type="button"
      >
        Switch to advanced mode
      </button>
      .
    </p>
  );
}
