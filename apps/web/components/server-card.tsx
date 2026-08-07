import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { LOADER_LABELS, type MinecraftLoader, type ServerStatus } from '@platter/shared';
import { presentStatus } from '@/lib/status';

export interface ServerCardProps {
  id: string;
  name: string;
  status: ServerStatus;
  loader: MinecraftLoader;
  gameVersion: string;
  port: number;
  memoryMiB: number;
  statusMessage: string | null;
  /**
   * Host part of the connect address.
   *
   * Passed in rather than hardcoded to `localhost`, which is what every card used to show — an
   * address that only works for the person already looking at the screen. Resolved once by the
   * dashboard for the whole grid, since it is the same answer for every card.
   */
  host: string;
}

/**
 * One server, at a glance.
 *
 * A card rather than a table row because each server passes the card test — it is an
 * independent thing you can open, stop, or delete on its own, and it carries a mixed payload
 * (name, status, address, size) that a columnar layout would flatten. The address is the reason
 * this page exists, so it gets monospace and sits on the footer line where it is easy to find
 * twice a week without reading the rest.
 */
export function ServerCard({
  id,
  name,
  status,
  loader,
  gameVersion,
  port,
  memoryMiB,
  host,
  statusMessage,
}: ServerCardProps) {
  const presentation = presentStatus(status);

  return (
    <ClickableCard label={`Open ${name}`} href={`/servers/${id}`} padding={4}>
      <VStack gap={3}>
        <HStack justify="between" align="start" gap={3}>
          {/*
           * `StackItem size="fill"`, which applies the flex min-width reset a row item needs.
           *
           * The previous `minHeight={0}` was the right idea on the wrong axis. A row-direction
           * flex item defaults to `min-width: auto`, so the heading's flex base is the full
           * width of its text and it never shrinks — `maxLines` then has nothing to truncate.
           * Measured with a long name: the title overflowed its card by 103px, hard-clipped
           * mid-word with no ellipsis, and pushed the status indicator entirely outside the
           * card. On a dashboard whose whole job is answering "is everything up", a long name
           * deleted the answer.
           */}
          <StackItem size="fill">
            <VStack gap={0.5}>
              <Heading level={2} maxLines={1}>
                {name}
              </Heading>
              <Text type="supporting">
                {LOADER_LABELS[loader]} · {gameVersion}
              </Text>
            </VStack>
          </StackItem>

          <HStack gap={1.5} align="center">
            <StatusDot
              variant={presentation.variant}
              label={presentation.label}
              tooltip={presentation.tooltip}
              isPulsing={presentation.pulsing}
            />
            <Text type="supporting">{presentation.label}</Text>
          </HStack>
        </HStack>

        {/*
         * Suppressed when it merely restates the status word directly above it. Half the cards
         * on a fresh dashboard otherwise read "Stopped" over a sentence saying the same thing
         * in more words, which trains people to stop reading the line that occasionally
         * carries the real reason a server died.
         */}
        {statusMessage &&
        !statusMessage.toLowerCase().startsWith(presentation.label.toLowerCase()) ? (
          <Text type="supporting" maxLines={2}>
            {statusMessage}
          </Text>
        ) : null}

        <Divider />

        <HStack justify="between" align="center" gap={2}>
          <Text type="supporting">
            <span className="platter-mono">
              {host}:{port}
            </span>
          </Text>
          {/* Metadata, so supporting text. A badge here competes with the status indicator
              on every card for a value nobody acts on. */}
          <Text type="supporting">{formatMemory(memoryMiB)} RAM</Text>
        </HStack>
      </VStack>
    </ClickableCard>
  );
}

function formatMemory(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB` : `${mib} MB`;
}
