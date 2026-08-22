import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdvancedOnly } from '@/components/common/advanced-disclosure';
import { AdvancedModeProvider } from '@/lib/advanced-mode';

/**
 * Easy mode is the default, and the escape hatch is not optional.
 *
 * Two properties are worth pinning because getting either wrong is invisible in review: a
 * fresh browser must start simple, and something the user has to act on must never be hidden
 * by a preference they do not know they have.
 */

function renderIn(advanced: boolean, ui: React.ReactNode) {
  localStorage.clear();
  if (advanced) localStorage.setItem('platter.advanced-mode', 'on');
  return render(<AdvancedModeProvider>{ui}</AdvancedModeProvider>);
}

describe('advanced mode', () => {
  it('starts in easy mode, so a fresh install hides the technical settings', () => {
    renderIn(false, <AdvancedOnly>heap size</AdvancedOnly>);
    expect(screen.queryByText('heap size')).not.toBeInTheDocument();
  });

  it('shows everything once the operator opts in', () => {
    renderIn(true, <AdvancedOnly>heap size</AdvancedOnly>);
    expect(screen.getByText('heap size')).toBeInTheDocument();
  });

  it('still shows a forced section in easy mode', () => {
    // The case this exists for: a server that failed to install, whose repair tool is
    // "advanced". Hiding it would leave the user stuck with no route forward and no reason
    // to suspect a preference is why.
    renderIn(false, <AdvancedOnly force>reinstall</AdvancedOnly>);
    expect(screen.getByText('reinstall')).toBeInTheDocument();
  });

  it('treats unreadable storage as easy mode rather than crashing', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      render(
        <AdvancedModeProvider>
          <AdvancedOnly>heap size</AdvancedOnly>
        </AdvancedModeProvider>,
      );
      expect(screen.queryByText('heap size')).not.toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
