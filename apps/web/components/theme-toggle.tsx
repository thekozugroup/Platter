'use client';

import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { VStack } from '@astryxdesign/core/VStack';
import { type ThemeMode, useThemeMode } from '@/app/providers';

/**
 * Light / dark / system.
 *
 * `system` is listed and is the default, because a local tool sitting alongside the user's other
 * windows should match them without being asked.
 */
export function ThemeToggle() {
  const { mode, setMode } = useThemeMode();

  return (
    <VStack padding={2}>
      <SegmentedControl
        label="Appearance"
        value={mode}
        onChange={(value: string) => setMode(value as ThemeMode)}
        size="sm"
      >
        <SegmentedControlItem value="light" label="Light" />
        <SegmentedControlItem value="dark" label="Dark" />
        <SegmentedControlItem value="system" label="Auto" />
      </SegmentedControl>
    </VStack>
  );
}
