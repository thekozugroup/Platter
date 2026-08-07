'use client';

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';

/**
 * A labelled machine value with a copy button.
 *
 * The button confirms in place rather than firing a toast — the action is trivial, and a toast
 * for "copied" is noise that competes with the toasts that actually matter (a server crashed, a
 * backup failed).
 *
 * `secret` masks the value until revealed. Used for anything that grants control, so a shared
 * screen or a screenshot does not leak it by default.
 */
export function CopyableValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions). The value is visible on
      // screen, so selecting it by hand still works — nothing useful to announce here.
    }
  };

  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      <HStack gap={2} align="center">
        <Text type="code">{revealed ? value : '•'.repeat(Math.min(value.length, 24))}</Text>
        {secret ? (
          <Button
            label={revealed ? 'Hide' : 'Show'}
            variant="ghost"
            size="sm"
            onClick={() => setRevealed((current) => !current)}
          />
        ) : null}
        <Button
          label={copied ? 'Copied' : 'Copy'}
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
        />
      </HStack>
    </VStack>
  );
}
