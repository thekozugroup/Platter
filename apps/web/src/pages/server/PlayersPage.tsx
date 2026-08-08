import { formatCount } from '@platter/shared';
import { ErrorState } from '@/components/common/error-state';
import { PageBody } from '@/components/layout/page-header';
import { AccessLists } from '@/components/players/access-lists';
import { PlayerList } from '@/components/players/player-list';
import {
  ROSTER_UNAVAILABLE_FIX,
  ROSTER_UNAVAILABLE_TITLE,
  blockedReasonFor,
} from '@/components/players/player-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { usePlayerRoster } from '@/hooks/use-players.js';
import { useServerScope } from '@/pages/server/ServerLayout';

/**
 * Players: who is on the server now, who has ever been, and who is allowed to be.
 *
 * The state this screen has to get right is not the happy one. A Minecraft server with RCON
 * switched off, or one that is simply stopped, is the common case — not a failure — and the
 * API is built for that: the roster comes back `200` with an `unavailable` code and whatever
 * history Platter recorded from the console. So an unreachable server reads here as an
 * explained state with a way forward, never as an error page, and the history stays visible
 * underneath it.
 *
 * No `PageHeader`: this is a child of `ServerLayout`, which owns the server's name, status
 * and tabs, and supplies both to this screen through `useServerScope`.
 */

const SECTION_HEADING = 'text-title-2 text-label';

export function PlayersPage() {
  const { server, status } = useServerScope();
  const serverId = server.id;
  const serverName = server.name;
  const isRunning = status === 'running';

  // Polling only while it is running: a stopped server's roster cannot change, and a
  // request every ten seconds that always returns the same answer is just noise.
  const roster = usePlayerRoster(serverId, { refetchInterval: isRunning ? 10_000 : false });

  if (roster.isError) {
    return (
      <PageBody>
        <ErrorState
          error={roster.error}
          onRetry={() => void roster.refetch()}
          title="Couldn’t load the player list"
        />
      </PageBody>
    );
  }

  const data = roster.data;
  const unavailable = data?.unavailable ?? null;
  const blockedReason = blockedReasonFor(unavailable);
  const players = data?.players ?? [];
  const onlineCount = data?.onlineCount ?? 0;

  return (
    <PageBody>
      <div className="flex flex-col gap-12 lg:gap-16">
        {/* ------------------------------------------------------------- Online right now */}
        <section aria-labelledby="players-online" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className={SECTION_HEADING} id="players-online">
              Online now
            </h2>
            <p
              aria-live="polite"
              className="text-subhead text-label-secondary tabular"
              role="status"
            >
              {roster.isPending
                ? 'Checking who is on…'
                : data?.maxPlayers
                  ? `${onlineCount} of ${data.maxPlayers} slots in use`
                  : formatCount(onlineCount, 'player online', 'players online')}
            </p>
          </div>

          {unavailable ? (
            <Alert variant={unavailable === 'offline' ? 'info' : 'warning'}>
              <AlertTitle className="font-sans">{ROSTER_UNAVAILABLE_TITLE[unavailable]}</AlertTitle>
              <AlertDescription>
                <p>{ROSTER_UNAVAILABLE_FIX[unavailable]}</p>
                {data?.unavailableMessage ? (
                  <p className="font-mono text-caption text-label-tertiary">
                    {data.unavailableMessage}
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <PlayerList
            blockedReason={blockedReason}
            emptyDescription={
              unavailable
                ? 'Platter cannot see who is connected right now, so this list stays empty until it can.'
                : 'Nobody is connected. Share the connect address from the server’s overview and they will appear here as they join.'
            }
            emptyTitle={unavailable ? 'Nobody can be listed right now' : 'Nobody is playing'}
            isLoading={roster.isPending}
            players={players}
            scope="online"
            serverId={serverId}
            serverName={serverName}
          />

          {data && data.source === 'logs' && !unavailable ? (
            <p className="text-caption text-label-tertiary">
              Built from the console log rather than a live query, so it can lag by a few seconds.
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------------------------- Everyone */}
        <section aria-labelledby="players-all" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className={SECTION_HEADING} id="players-all">
              Everyone who has played
            </h2>
            <p className="text-subhead text-label-secondary">
              Every name Platter has seen join, with how long they stayed. This survives the server
              being stopped.
            </p>
          </div>

          <PlayerList
            blockedReason={blockedReason}
            emptyDescription="Nobody has joined yet. The first person to connect appears here, and stays even after they leave."
            emptyTitle="No players recorded"
            isLoading={roster.isPending}
            players={players}
            scope="all"
            searchable
            serverId={serverId}
            serverName={serverName}
          />
        </section>

        {/* --------------------------------------------------------------- Access lists */}
        <section aria-labelledby="players-access" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className={SECTION_HEADING} id="players-access">
              Who is allowed in
            </h2>
            <p className="text-subhead text-label-secondary">
              Set these up before a session — every list takes a name, whether or not that person
              has ever joined.
            </p>
          </div>

          <AccessLists
            blockedReason={blockedReason}
            isLoading={roster.isPending}
            players={players}
            serverId={serverId}
            serverName={serverName}
          />
        </section>
      </div>
    </PageBody>
  );
}
