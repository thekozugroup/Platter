'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import type { ServerStatus } from '@platter/shared';
import { useState, useTransition } from 'react';
import {
  type ActionState,
  deleteServerAction,
  restartServerAction,
  startServerAction,
  stopServerAction,
} from '@/lib/actions';
import { availableActions } from '@/lib/status';

/**
 * Start, stop, restart, delete.
 *
 * Buttons are disabled during transitional states rather than hidden, so the control set does
 * not reflow while a server boots — a row of buttons that moves under the cursor is how people
 * click the wrong one.
 *
 * Deletion separates the two decisions. Everyone else's panel makes "delete" a single
 * irreversible button, and the recurring complaint across all of them is people losing worlds
 * they meant to keep. Here, removing the server and destroying its data are different choices,
 * and the destructive one requires typing the server's name.
 */
export function ServerControls({
  serverId,
  status,
  name,
}: {
  serverId: string;
  status: ServerStatus;
  name: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purgeData, setPurgeData] = useState(false);
  const [typedName, setTypedName] = useState('');
  const showToast = useToast();

  const actions = availableActions(status);
  const canDelete = !purgeData || typedName.trim() === name;

  const run = (action: () => Promise<ActionState>, successMessage: string) => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        showToast({ body: successMessage, type: 'info' });
      } else {
        showToast({ body: result.message ?? 'Something went wrong.', type: 'error' });
      }
    });
  };

  const openConfirm = () => {
    setPurgeData(false);
    setTypedName('');
    setConfirmOpen(true);
  };

  return (
    <>
      <HStack gap={2} wrap="wrap">
        <Button
          label="Start"
          variant="primary"
          isDisabled={!actions.start || pending}
          onClick={() => run(() => startServerAction(serverId), `${name} is starting.`)}
        />
        <Button
          label="Restart"
          isDisabled={!actions.restart || pending}
          onClick={() => run(() => restartServerAction(serverId), `${name} is restarting.`)}
        />
        <Button
          label="Stop"
          isDisabled={!actions.stop || pending}
          onClick={() => run(() => stopServerAction(serverId), `Stopping ${name}…`)}
        />
        <Button label="Delete" variant="destructive" isDisabled={pending} onClick={openConfirm} />
      </HStack>

      <Dialog isOpen={confirmOpen} onOpenChange={setConfirmOpen} purpose="form" width={480}>
        <DialogHeader title={`Delete ${name}?`} onOpenChange={setConfirmOpen} />
        <VStack padding={4} gap={4}>
          <Text>
            The container will be removed. By default the world, mods and backups stay on disk, so
            you can recreate the server and point it at the same data.
          </Text>

          <CheckboxList
            label="Data"
            isLabelHidden
            value={purgeData ? ['purge'] : []}
            onChange={(values) => setPurgeData(values.includes('purge'))}
          >
            <CheckboxListItem
              value="purge"
              label="Also delete the world, mods and every backup"
              description="Permanent. Nothing is recoverable afterwards."
            />
          </CheckboxList>

          {purgeData ? (
            <VStack gap={2}>
              <Banner
                status="error"
                title="This cannot be undone"
                description={`Type "${name}" to confirm you want to destroy the data.`}
              />
              {/* A confirmation input, not layout — the field label is the banner above it. */}
              <input
                aria-label={`Type ${name} to confirm`}
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={name}
                style={{
                  padding: 'var(--spacing-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-background-surface)',
                  color: 'var(--color-content-primary)',
                  font: 'inherit',
                }}
              />
            </VStack>
          ) : null}

          <HStack gap={2} justify="end">
            <Button label="Cancel" variant="ghost" onClick={() => setConfirmOpen(false)} />
            <Button
              label={purgeData ? 'Delete everything' : 'Delete server'}
              variant="destructive"
              isLoading={pending}
              isDisabled={!canDelete || pending}
              onClick={() => {
                startTransition(async () => {
                  const result = await deleteServerAction(serverId, purgeData);
                  if (!result.ok) {
                    showToast({ body: result.message ?? 'Could not delete.', type: 'error' });
                    setConfirmOpen(false);
                  }
                });
              }}
            />
          </HStack>
        </VStack>
      </Dialog>
    </>
  );
}
