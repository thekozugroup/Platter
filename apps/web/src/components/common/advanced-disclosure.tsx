import { useAdvancedMode } from '@/lib/advanced-mode';

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
