import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import type { Actor, EventLevel } from '@platter/shared';

export interface ActivityEvent {
  id: string;
  type: string;
  level: EventLevel;
  message: string;
  actor: Actor;
  createdAt: number;
  serverId: string | null;
}

const LEVEL_VARIANT: Record<EventLevel, 'success' | 'warning' | 'error' | 'neutral'> = {
  debug: 'neutral',
  info: 'neutral',
  warn: 'warning',
  error: 'error',
};

/**
 * The activity feed.
 *
 * Rows, not cards: this is dense scannable data and the whole value is being able to read down
 * it quickly. Anything an AI agent did is tagged, because "why did my server restart at 3am"
 * should be answerable in one glance rather than by reading a log.
 */
export function ActivityList({
  events,
  emptyMessage = 'Nothing yet.',
}: {
  events: ActivityEvent[];
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return <Text type="supporting">{emptyMessage}</Text>;
  }

  return (
    <List density="compact">
      {events.map((event) => (
        <ListItem
          key={event.id}
          label={event.message}
          startContent={<StatusDot variant={LEVEL_VARIANT[event.level]} label={event.level} />}
          endContent={
            <HStack gap={2} align="center">
              {event.actor === 'ai' ? <Token label="AI" size="sm" color="purple" /> : null}
              {event.actor === 'schedule' ? (
                <Token label="Scheduled" size="sm" color="gray" />
              ) : null}
              <Text type="supporting">
                <Timestamp value={new Date(event.createdAt).toISOString()} format="relative" />
              </Text>
            </HStack>
          }
        />
      ))}
    </List>
  );
}
