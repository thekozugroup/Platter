'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { useToast } from '@astryxdesign/core/Toast';
import type { ServerStatus } from '@platter/shared';
import { useState, useTransition } from 'react';
import {
  createBackupAction,
  deleteBackupAction,
  restoreBackupAction,
} from '@/lib/actions';

export interface BackupRow {
  id: string;
  label: string | null;
  status: string;
  statusMessage: string | null;
  sizeBytes: number | null;
  hotBackup: boolean;
  trigger: string;
  createdAt: number;
}

/**
 * Backups are a table, not cards.
 *
 * They are dense, uniform, scannable rows where the useful comparison is across a column — when,
 * how big, taken how. That is exactly what a table is for, and card-wrapping each one would push
 * three backups off the fold.
 */
export function BackupsPanel({
  serverId,
  serverStatus,
  retention,
  schedule,
  backups,
}: {
  serverId: string;
  serverStatus: ServerStatus;
  retention: number;
  schedule: string | null;
  backups: BackupRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [restoring, setRestoring] = useState<BackupRow | null>(null);
  const showToast = useToast();

  const isLive = serverStatus === 'running';

  return (
    <VStack gap={4}>
      <Card padding={4}>
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <VStack gap={0.5}>
            <Text weight="medium">
              {schedule ? 'Backing up nightly' : 'No schedule'}
            </Text>
            <Text type="supporting">
              Keeping the most recent {retention}.{' '}
              {isLive
                ? 'The server is running, so this will be a live snapshot.'
                : 'The server is stopped, so this will be a cold copy.'}
            </Text>
          </VStack>
          <Button
            label="Back up now"
            variant="primary"
            isLoading={pending}
            isDisabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await createBackupAction(serverId);
                showToast({
                  body: result.ok ? 'Backup complete.' : (result.message ?? 'Backup failed.'),
                  type: result.ok ? 'info' : 'error',
                });
              });
            }}
          />
        </HStack>
      </Card>

      {backups.length === 0 ? (
        <EmptyState
          title="No backups yet"
          description="Take one now, or leave the nightly schedule to do it for you."
          isCompact
        />
      ) : (
        <Table label="Backups">
          <TableRow isHeader>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>Size</TableHeaderCell>
            <TableHeaderCell>Taken</TableHeaderCell>
            <TableHeaderCell>{''}</TableHeaderCell>
          </TableRow>
          {backups.map((backup) => (
            <TableRow key={backup.id}>
              <TableCell>
                <VStack gap={0.5}>
                  <Timestamp value={new Date(backup.createdAt).toISOString()} format="auto" />
                  {backup.label ? <Text type="supporting">{backup.label}</Text> : null}
                  {backup.status === 'failed' ? (
                    <Text type="supporting" color="accent">
                      {backup.statusMessage ?? 'Failed'}
                    </Text>
                  ) : null}
                </VStack>
              </TableCell>
              <TableCell>
                <Text type="code">
                  {backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}
                </Text>
              </TableCell>
              <TableCell>
                <HStack gap={1.5} wrap="wrap">
                  <Badge
                    label={backup.hotBackup ? 'Live' : 'Offline'}
                    variant={backup.hotBackup ? 'success' : 'neutral'}
                  />
                  <Badge label={triggerLabel(backup.trigger)} variant="neutral" />
                </HStack>
              </TableCell>
              <TableCell>
                <HStack gap={1} justify="end">
                  <Button
                    label="Restore"
                    size="sm"
                    isDisabled={backup.status !== 'complete' || pending}
                    onClick={() => setRestoring(backup)}
                  />
                  <Button
                    label="Delete"
                    variant="ghost"
                    size="sm"
                    isDisabled={pending}
                    onClick={() => {
                      startTransition(async () => {
                        const result = await deleteBackupAction(serverId, backup.id);
                        if (!result.ok) {
                          showToast({
                            body: result.message ?? 'Could not delete.',
                            type: 'error',
                          });
                        }
                      });
                    }}
                  />
                </HStack>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}

      <Dialog
        isOpen={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        purpose="form"
        width={480}
      >
        <DialogHeader
          title="Restore this backup?"
          onOpenChange={(open) => !open && setRestoring(null)}
        />
        <VStack padding={4} gap={4}>
          <Text>
            The server will stop, its current data will be replaced by this backup, and it will
            start again. Anything built since{' '}
            {restoring ? new Date(restoring.createdAt).toLocaleString() : 'then'} will be gone.
          </Text>
          <Text type="supporting">
            Platter takes a safety backup of the current state first, so this is reversible.
          </Text>
          <HStack gap={2} justify="end">
            <Button label="Cancel" variant="ghost" onClick={() => setRestoring(null)} />
            <Button
              label="Restore"
              variant="primary"
              isLoading={pending}
              onClick={() => {
                const target = restoring;
                if (!target) {
                  return;
                }
                startTransition(async () => {
                  const result = await restoreBackupAction(serverId, target.id);
                  setRestoring(null);
                  showToast({
                    body: result.ok
                      ? 'Restored. The server is starting again.'
                      : (result.message ?? 'Restore failed.'),
                    type: result.ok ? 'info' : 'error',
                  });
                });
              }}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case 'schedule':
      return 'Scheduled';
    case 'pre-change':
      return 'Before change';
    case 'pre-restore':
      return 'Safety copy';
    default:
      return 'Manual';
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
