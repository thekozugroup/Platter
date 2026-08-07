import { Badge } from '@astryxdesign/core/Badge';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
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
  statusMessage,
}: ServerCardProps) {
  const presentation = presentStatus(status);

  return (
    <ClickableCard label={`Open ${name}`} href={`/servers/${id}`} padding={4}>
      <VStack gap={3}>
        <HStack justify="between" align="start" gap={3}>
          <VStack gap={0.5} minHeight={0}>
            <Heading level={2} maxLines={1}>
              {name}
            </Heading>
            <Text type="supporting">
              {LOADER_LABELS[loader]} · {gameVersion}
            </Text>
          </VStack>

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

        {statusMessage ? (
          <Text type="supporting" maxLines={2}>
            {statusMessage}
          </Text>
        ) : null}

        <Divider />

        <HStack justify="between" align="center" gap={2}>
          <Text type="supporting">
            <span className="platter-mono">localhost:{port}</span>
          </Text>
          <Badge label={`${formatMemory(memoryMiB)} RAM`} variant="neutral" />
        </HStack>
      </VStack>
    </ClickableCard>
  );
}

function formatMemory(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB` : `${mib} MB`;
}
