import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlueprintSummary } from '@platter/shared';
import { GameIcon } from '@/components/common/game-icon';
import { StatusCapsule } from '@/components/common/status-pill';
import { ModIcon } from '@/components/mods/mod-card';
import { blueprintEdition, blueprintSubtitle } from '@/components/servers/server-card';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * The design-contract rules that were fixed once and then reappeared one file over.
 *
 * Each of these was a real, shipped defect: a hand-rolled status pill that painted its own
 * label, a mod mark that copied `GameIcon`'s formula from before the contrast solve and kept
 * the chrome's radius, a picker that printed "Valheim / Valheim", and a checkbox whose
 * caller-supplied `id` reached nothing, leaving twenty permission controls nameless. They
 * are cheap to reintroduce by copying a neighbouring component, so they are asserted here
 * rather than left to the next audit.
 */

// ---------------------------------------------------------------------------------------
// Status capsules — the word never carries the colour
// ---------------------------------------------------------------------------------------

describe('StatusCapsule', () => {
  it.each(['success', 'warning', 'danger', 'neutral'] as const)(
    'keeps the %s label near-black and puts the tone on the dot',
    (tone) => {
      const { container } = render(<StatusCapsule tone={tone}>Online</StatusCapsule>);
      const capsule = screen.getByText('Online');

      // The label class list must never contain a status colour: on the pill surface,
      // `text-success` measures 3.31:1 and `text-warning` 3.77:1 — both under AA.
      expect(capsule.className).toContain('text-label');
      expect(capsule.className).not.toMatch(/text-(success|warning|danger)\b/);

      const dot = container.querySelector('span[aria-hidden="true"]');
      expect(dot?.className).toMatch(/bg-(success-dot|warning-dot|danger-dot|neutral-status)/);
    },
  );

  it('still says the word when colour is unavailable', () => {
    render(<StatusCapsule tone="danger">Offline</StatusCapsule>);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Game and mod marks — square, and legible at every hue
// ---------------------------------------------------------------------------------------

describe('generated marks', () => {
  it('never rounds a game mark, at any size', () => {
    for (const size of ['xs', 'sm', 'md', 'lg'] as const) {
      const { container, unmount } = render(<GameIcon name="Survival SMP" size={size} />);
      expect(container.firstElementChild?.className).toContain('rounded-none');
      unmount();
    }
  });

  it('shows two monogram characters in the sidebar size, so two servers do not collide', () => {
    const { container: a } = render(<GameIcon monogram="MC" name="Survival SMP" size="xs" />);
    const { container: b } = render(<GameIcon monogram="MC" name="Creative" size="xs" />);
    expect(a.firstElementChild?.textContent).toBe('MC');
    expect(b.firstElementChild?.textContent).toBe('MC');
  });

  it('draws a mod fallback through GameIcon: square, and legible at every hue', () => {
    const { container } = render(<ModIcon iconUrl={null} title="Fabric API" />);
    const mark = container.firstElementChild as HTMLElement;

    expect(mark.className).toContain('rounded-none');
    expect(mark.className).not.toContain('rounded-xs');
    expect(mark.getAttribute('style')).toMatch(/linear-gradient/);
  });

  it.each([
    'Fabric API',
    'WorldEdit',
    'Citizens',
    'Iris Shaders',
    'Simple Voice Chat',
    'Chunky',
  ])('prints %s’s monogram at 4.5:1 or better', (title) => {
    // Each of these hashed to a hue where the old hard-coded 48% lightness put white
    // between 2.2:1 and 2.6:1. `GameIcon.legibleLightness` solves the stop per hue.
    const { container } = render(<ModIcon iconUrl={null} title={title} />);
    const mark = container.firstElementChild as HTMLElement;

    // jsdom serialises the `hsl()` stops to `rgb()`, which is what we want to measure.
    const stops = [...(mark.getAttribute('style') ?? '').matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)];
    expect(stops).toHaveLength(2);

    const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const contrastWithWhite = (rgb: number[]) => {
      const [r = 0, g = 0, b = 0] = rgb.map((v) => channel(v / 255));
      return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
    };

    for (const stop of stops) {
      expect(contrastWithWhite(stop.slice(1, 4).map(Number))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('does not round a mod’s own artwork either', () => {
    const { container } = render(<ModIcon iconUrl="https://example.test/i.png" title="WorldEdit" />);
    const img = container.querySelector('img');
    expect(img?.className).not.toContain('rounded');
  });
});

// ---------------------------------------------------------------------------------------
// Blueprint naming — the game is printed once
// ---------------------------------------------------------------------------------------

function blueprint(game: string, name: string): BlueprintSummary {
  return {
    key: 'k',
    name,
    game,
    summary: '',
    category: 'sandbox',
    icon: { monogram: 'XX', hue: 200 },
    minMemoryMb: 1024,
    recommendedMemoryMb: 2048,
    minDiskMb: 4096,
    features: { console: true, rcon: false, mods: false, worldUpload: false, playerList: false },
  };
}

describe('blueprint naming', () => {
  it('has no edition when the blueprint is the game itself', () => {
    expect(blueprintEdition(blueprint('Valheim', 'Valheim'))).toBeNull();
    expect(blueprintSubtitle('valheim', blueprint('Valheim', 'Valheim'))).toBe('Valheim');
  });

  it('strips the repeated game name from an edition', () => {
    const mc = blueprint('Minecraft', 'Minecraft: Java Edition');
    expect(blueprintEdition(mc)).toBe('Java Edition');
    expect(blueprintSubtitle('minecraft-java', mc)).toBe('Minecraft · Java Edition');
  });

  it('falls back to the key when the blueprint has not loaded', () => {
    expect(blueprintSubtitle('palworld')).toBe('palworld');
  });
});

// ---------------------------------------------------------------------------------------
// Checkbox naming — the caller's id reaches the real control
// ---------------------------------------------------------------------------------------

describe('Checkbox', () => {
  it('routes a caller id to the input so an external label names and toggles it', async () => {
    const user = userEvent.setup();

    function Harness() {
      return (
        <div>
          <Checkbox id="perm-server.delete" />
          <label htmlFor="perm-server.delete">Delete the server</label>
        </div>
      );
    }

    render(<Harness />);

    const box = screen.getByRole('checkbox', { name: 'Delete the server' });
    expect(box).toBeInstanceOf(HTMLInputElement);
    expect(box.id).toBe('perm-server.delete');

    // Ark used to re-key the id to `checkbox:<id>`, so this element did not exist at all.
    expect(document.getElementById('perm-server.delete')).toBe(box);

    await user.click(screen.getByText('Delete the server'));
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it('puts aria-label on the input rather than on its wrapper label', () => {
    render(<Checkbox aria-label="Select config.yml" />);
    const box = screen.getByRole('checkbox', { name: 'Select config.yml' });
    expect(box.tagName).toBe('INPUT');
  });

  it('reports exactly one checkbox per control', () => {
    // The wrapper is a <label>; giving it `role="checkbox"` reported a second, nameless one.
    render(<Checkbox aria-label="Only me" />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
