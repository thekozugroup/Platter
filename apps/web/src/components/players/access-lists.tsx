import { useId, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import {
  playerApi,
  usePlayerCommand,
  type BanEntry,
  type PlayerRecord,
} from '@/components/players/player-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useBans, useWhitelist } from '@/hooks/use-players.js';
import { cn } from '@/lib/utils';

/**
 * The three lists that decide who may play: the whitelist, the operators, and the bans.
 *
 * The important behaviour here is that **a player who has never joined can be added**. That is
 * not an edge case, it is the normal way a whitelist gets set up — you collect names from six
 * friends on a Friday and put them in. A UI that only lets you tick people who already appear
 * in the roster makes the common case impossible, so every list takes a free-text name.
 *
 * What this screen must *not* do is promise more than the API can keep. Every write here is a
 * console command sent over RCON (`apps/api/src/services/players.ts` — `setWhitelisted`,
 * `setOperator`, `ban`, `pardon` all route through `runAdminCommand`), so a stopped server
 * cannot be edited even though its lists can be *read* from `whitelist.json` and the ban files
 * on disk. Earlier copy here said the opposite in three places — "you can do this before the
 * server is even running", "changes are written when it next starts" — beside a disabled
 * button whose own reason said "start the server to manage players". The wording now matches
 * what happens, and says which side of that line each thing is on.
 *
 * Operators are derived from the roster rather than fetched: the API exposes `op` on each
 * player record and has no separate operators endpoint. That means an operator added directly
 * in `ops.json` while Platter was not watching will not appear until they next join, and the
 * card says so rather than implying the list is complete.
 *
 * The reason a control is disabled is stated **once per screen** — the banner at the top of
 * this component — and reachable from every disabled control as a tooltip and an
 * `aria-describedby` target. Printing the full sentence under each control put six copies of
 * "RCON has no password yet…" on one viewport.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';
const CARD_TITLE = 'font-sans text-title-3 font-semibold';

// ---------------------------------------------------------------------------------------

interface AddByNameProps {
  label: string;
  helper: ReactNode;
  placeholder: string;
  submitLabel: string;
  /** Non-null disables the form and explains why. */
  blockedReason: string | null;
  isPending: boolean;
  maxLength?: number;
  onSubmit: (value: string) => void;
}

function AddByName({
  label,
  helper,
  placeholder,
  submitLabel,
  blockedReason,
  isPending,
  maxLength = 32,
  onSubmit,
}: AddByNameProps) {
  const [value, setValue] = useState('');
  const hintId = useId();
  const trimmed = value.trim();
  const disabledReason = blockedReason ?? (trimmed.length === 0 ? 'Type a name first.' : null);

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason) return;
        onSubmit(trimmed);
        setValue('');
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-0 max-w-xs flex-1">
          <FieldLabel>{label}</FieldLabel>
          <Input
            autoComplete="off"
            className="h-11"
            maxLength={maxLength}
            name="name"
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            value={value}
          />
          <FieldHelper>{helper}</FieldHelper>
        </Field>

        {/*
          The reason travels with the control rather than under it: the wrapper keeps its
          pointer events while the disabled button drops them, so it can carry the tooltip,
          and the sr-only copy is what `aria-describedby` resolves to. The banner above the
          cards states the same sentence once, in full.
        */}
        {disabledReason ? (
          <span className="inline-flex" title={disabledReason}>
            <Button
              aria-describedby={hintId}
              className={ACTION}
              disabled
              isLoading={isPending}
              size="lg"
              type="submit"
            >
              {submitLabel}
            </Button>
            <span className="sr-only" id={hintId}>
              {disabledReason}
            </span>
          </span>
        ) : (
          <Button className={ACTION} isLoading={isPending} size="lg" type="submit">
            {submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------

interface EntryRow {
  key: string;
  primary: string;
  secondary?: string | undefined;
  actionLabel: string;
  onAction: () => void;
  isPending: boolean;
}

function EntryList({
  rows,
  blockedReason,
  emptyTitle,
  emptyDescription,
}: {
  rows: EntryRow[];
  blockedReason: string | null;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return <EmptyState description={emptyDescription} size="sm" title={emptyTitle} />;
  }

  return (
    <ul className="divide-y divide-separator border-t border-separator">
      {rows.map((row) => (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.key}>
          <div className="min-w-0">
            <p className="truncate font-mono text-callout text-label">{row.primary}</p>
            {row.secondary ? (
              <p className="mt-0.5 text-caption text-label-tertiary">{row.secondary}</p>
            ) : null}
          </div>
          {blockedReason ? (
            <span className="inline-flex" title={blockedReason}>
              <Button
                aria-describedby={`${row.key}-blocked`}
                className={ACTION}
                disabled
                size="lg"
                variant="outline"
              >
                {row.actionLabel}
              </Button>
              <span className="sr-only" id={`${row.key}-blocked`}>
                {blockedReason}
              </span>
            </span>
          ) : (
            <Button
              className={ACTION}
              isLoading={row.isPending}
              onClick={row.onAction}
              size="lg"
              variant="outline"
            >
              {row.actionLabel}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------

function WhitelistCard({
  serverId,
  blockedReason,
}: {
  serverId: string;
  blockedReason: string | null;
}) {
  const labelId = useId();
  const toggleHintId = useId();
  const command = usePlayerCommand(serverId);

  const whitelist = useWhitelist(serverId);

  const names = whitelist.data?.names ?? [];
  const enabled = whitelist.data?.enabled ?? null;
  const unknownState = enabled === null;
  // Only the reason that is *not* already in the banner above is worth printing here.
  const unknownStateReason = unknownState
    ? 'Platter cannot read whether the whitelist is on. It reads this from the running server.'
    : null;
  const toggleBlocked = blockedReason ?? unknownStateReason;

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild className={CARD_TITLE}>
          <h3>Whitelist</h3>
        </CardTitle>
        <CardDescription>
          When the whitelist is on, only the names below can join. Operators can always join.
          Platter changes this list by sending a command to the running server, so it has to be up
          before you can add or remove anyone.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {whitelist.isPending ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : whitelist.isError ? (
          <ErrorState
            error={whitelist.error}
            onRetry={() => void whitelist.refetch()}
            title="Couldn’t read the whitelist"
            variant="inline"
          />
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-subhead font-medium text-label" id={labelId}>
                  Only whitelisted players can join
                </p>
                <p className="mt-1 text-caption text-label-secondary">
                  {unknownState
                    ? 'Currently unknown — this is read from the running server.'
                    : enabled
                      ? 'On. Players not on the list cannot join.'
                      : 'Off. Anyone who knows the address can join.'}
                </p>
                {!unknownState && !enabled && names.length === 0 ? (
                  <p className="mt-1 text-caption text-warning">
                    The list is empty. Turning this on now would keep everyone out except operators.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col items-end gap-1">
                {/*
                  Ark wires the hidden checkbox to `Switch.Label`, which Shark's Switch does not
                  render — so without this `ids` override the control would have no accessible
                  name at all. Pointing it at the visible sentence above is the fix.
                */}
                <Switch
                  aria-describedby={toggleBlocked ? toggleHintId : undefined}
                  checked={enabled ?? false}
                  className="hit-target"
                  disabled={Boolean(toggleBlocked) || command.isPending}
                  ids={{ label: labelId }}
                  title={toggleBlocked ?? undefined}
                  onCheckedChange={(details) =>
                    command.mutate({
                      id: `whitelist-enabled:${String(details.checked)}`,
                      done: details.checked ? 'Whitelist turned on' : 'Whitelist turned off',
                      failed: 'Couldn’t change the whitelist',
                      run: () => playerApi.setWhitelistEnabled(serverId, details.checked),
                    })
                  }
                />
                {/* The banner already carries `blockedReason`; only the state Platter cannot
                    read is new information, and only that is printed. */}
                {toggleBlocked ? (
                  unknownStateReason && !blockedReason ? (
                    <p
                      className="max-w-56 text-right text-caption text-label-tertiary"
                      id={toggleHintId}
                    >
                      {toggleBlocked}
                    </p>
                  ) : (
                    <span className="sr-only" id={toggleHintId}>
                      {toggleBlocked}
                    </span>
                  )
                ) : null}
              </div>
            </div>

            <AddByName
              blockedReason={blockedReason}
              helper="The player does not have to have joined before. The name is written to whitelist.json immediately."
              isPending={
                command.isPending && command.variables?.id.startsWith('whitelist-add') === true
              }
              label="Add a player"
              onSubmit={(name) =>
                command.mutate({
                  id: `whitelist-add:${name}`,
                  done: `Added ${name} to the whitelist`,
                  failed: `Couldn’t add ${name}`,
                  run: () => playerApi.whitelistAdd(serverId, name),
                })
              }
              placeholder="Notch"
              submitLabel="Add"
            />

            <EntryList
              blockedReason={blockedReason}
              emptyDescription="Add the names of everyone who should be able to join, whether or not they have played here before."
              emptyTitle="Nobody is whitelisted yet"
              rows={names.map((name) => ({
                key: `wl-${name}`,
                primary: name,
                actionLabel: 'Remove',
                isPending:
                  command.isPending && command.variables?.id === `whitelist-remove:${name}`,
                onAction: () =>
                  command.mutate({
                    id: `whitelist-remove:${name}`,
                    done: `Removed ${name} from the whitelist`,
                    failed: `Couldn’t remove ${name}`,
                    run: () => playerApi.whitelistRemove(serverId, name),
                  }),
              }))}
            />

            {whitelist.data && !whitelist.data.live ? (
              <p className="text-caption text-label-tertiary">
                Read from <code className="font-mono">whitelist.json</code> on disk, because the
                server is not answering. This is the list it will load on its next start, but it
                cannot be changed from here until it is running.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function OperatorsCard({
  serverId,
  serverName,
  players,
  blockedReason,
  isLoading,
}: {
  serverId: string;
  serverName: string;
  players: readonly PlayerRecord[];
  blockedReason: string | null;
  isLoading: boolean;
}) {
  const command = usePlayerCommand(serverId);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const operators = players.filter((player) => player.op);

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild className={CARD_TITLE}>
          <h3>Operators</h3>
        </CardTitle>
        <CardDescription>
          Operators can run any command on this server, including banning people and granting
          operator to others.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <AddByName
          blockedReason={blockedReason}
          helper="Granting operator gives someone full control of the server. Only do this for people you trust with it."
          isPending={command.isPending && command.variables?.id.startsWith('op:') === true}
          label="Make someone an operator"
          onSubmit={(name) => {
            setPendingName(name);
            setOpen(true);
          }}
          placeholder="Notch"
          submitLabel="Grant"
        />

        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-md" />
        ) : (
          <EntryList
            blockedReason={blockedReason}
            emptyDescription="Nobody Platter has seen on this server is an operator. Add one above to give them full control."
            emptyTitle="No operators yet"
            rows={operators.map((player) => ({
              key: `op-${player.name}`,
              primary: player.name,
              secondary:
                player.operatorLevel === null
                  ? undefined
                  : `Permission level ${player.operatorLevel}`,
              actionLabel: 'Remove operator',
              isPending: command.isPending && command.variables?.id === `deop:${player.name}`,
              onAction: () =>
                command.mutate({
                  id: `deop:${player.name}`,
                  done: `${player.name} is no longer an operator`,
                  failed: `Couldn’t change ${player.name}’s operator status`,
                  run: () => playerApi.setOperator(serverId, player.name, false),
                }),
            }))}
          />
        )}

        <p className="text-caption text-label-tertiary">
          This list is built from the players Platter has seen. Somebody added straight to{' '}
          <code className="font-mono">ops.json</code> will not appear here until they next join.
        </p>
      </CardContent>

      <AlertDialog onOpenChange={(details) => setOpen(details.open)} open={open}>
        {pendingName ? (
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-sans text-title-3 font-semibold">
                Make {pendingName} an operator?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Operators can run any command on{' '}
                <strong className="font-medium text-label">{serverName}</strong> — change the world,
                ban other players, and grant operator to anyone else. There is no partial version of
                this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className={ACTION}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={ACTION}
                onClick={() => {
                  const name = pendingName;
                  setOpen(false);
                  command.mutate({
                    id: `op:${name}`,
                    done: `${name} is now an operator`,
                    failed: `Couldn’t make ${name} an operator`,
                    run: () => playerApi.setOperator(serverId, name, true),
                  });
                }}
              >
                Make them an operator
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function banSecondary(entry: BanEntry): string | undefined {
  const parts: string[] = [];
  if (entry.reason) parts.push(entry.reason);
  if (entry.source) parts.push(`by ${entry.source}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function BansCard({ serverId, blockedReason }: { serverId: string; blockedReason: string | null }) {
  const command = usePlayerCommand(serverId);

  const bans = useBans(serverId);

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild className={CARD_TITLE}>
          <h3>Bans</h3>
        </CardTitle>
        <CardDescription>
          Banned players are disconnected and cannot rejoin. Banning an address stops everyone
          behind it, which is blunt but works when someone keeps making new accounts.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-8">
        {bans.isPending ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : bans.isError ? (
          <ErrorState
            error={bans.error}
            onRetry={() => void bans.refetch()}
            title="Couldn’t read the ban list"
            variant="inline"
          />
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h4 className="text-subhead font-medium text-label">Banned players</h4>
              <EntryList
                blockedReason={blockedReason}
                emptyDescription="Nobody is banned from this server."
                emptyTitle="No banned players"
                rows={bans.data.players.map((entry) => ({
                  key: `ban-${entry.target}`,
                  primary: entry.target,
                  secondary: banSecondary(entry),
                  actionLabel: 'Pardon',
                  isPending:
                    command.isPending && command.variables?.id === `pardon:${entry.target}`,
                  onAction: () =>
                    command.mutate({
                      id: `pardon:${entry.target}`,
                      done: `Pardoned ${entry.target}`,
                      failed: `Couldn’t pardon ${entry.target}`,
                      run: () => playerApi.pardon(serverId, entry.target),
                    }),
                }))}
              />
            </section>

            <section className="flex flex-col gap-3">
              <h4 className="text-subhead font-medium text-label">Banned addresses</h4>
              <AddByName
                blockedReason={blockedReason}
                helper="An IPv4 or IPv6 address. Everyone connecting from it is refused. Households and mobile networks often share one address."
                isPending={
                  command.isPending && command.variables?.id.startsWith('ban-ip:') === true
                }
                label="Ban an address"
                maxLength={45}
                onSubmit={(ip) =>
                  command.mutate({
                    id: `ban-ip:${ip}`,
                    done: `Banned ${ip}`,
                    failed: `Couldn’t ban ${ip}`,
                    run: () => playerApi.banIp(serverId, ip, null),
                  })
                }
                placeholder="203.0.113.4"
                submitLabel="Ban address"
              />
              <EntryList
                blockedReason={blockedReason}
                emptyDescription="No addresses are banned."
                emptyTitle="No banned addresses"
                rows={bans.data.ips.map((entry) => ({
                  key: `ip-${entry.target}`,
                  primary: entry.target,
                  secondary: banSecondary(entry),
                  actionLabel: 'Lift',
                  isPending:
                    command.isPending && command.variables?.id === `pardon-ip:${entry.target}`,
                  onAction: () =>
                    command.mutate({
                      id: `pardon-ip:${entry.target}`,
                      done: `Lifted the ban on ${entry.target}`,
                      failed: `Couldn’t lift the ban on ${entry.target}`,
                      run: () => playerApi.pardonIp(serverId, entry.target),
                    }),
                }))}
              />
            </section>

            {!bans.data.live ? (
              <p className="text-caption text-label-tertiary">
                Read from the ban files on disk, because the server is not answering. Banning and
                pardoning both need it running.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

export interface AccessListsProps {
  serverId: string;
  serverName: string;
  /** From the roster. Operators are read off it — the API has no operators endpoint. */
  players: readonly PlayerRecord[];
  /** Why nothing can be changed right now. Null when the server is answering. */
  blockedReason: string | null;
  /**
   * The same reason in a few words ("The server is not running"), for the one banner. The
   * full sentence stays on the controls it disables and in the page's own alert; repeating
   * all of it here would be the third copy of the same paragraph on one screen.
   */
  blockedTitle?: string | null;
  /** The roster is still in flight, so the derived operator list is not yet meaningful. */
  isLoading?: boolean;
  className?: string;
}

export function AccessLists({
  serverId,
  serverName,
  players,
  blockedReason,
  blockedTitle = null,
  isLoading = false,
  className,
}: AccessListsProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/*
        Said once, here, rather than under each of the eleven controls it applies to. Every
        disabled control still carries it as a tooltip and as its accessible description.
      */}
      {blockedReason ? (
        <Alert variant="warning">
          <AlertTitle className="font-sans">These lists cannot be changed right now</AlertTitle>
          <AlertDescription>
            {blockedTitle ? `${blockedTitle}. ` : ''}Every change here is a console command Platter
            sends to the running server, so the three lists below can be read but not edited. Each
            disabled control carries the reason.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <WhitelistCard blockedReason={blockedReason} serverId={serverId} />
        <OperatorsCard
          blockedReason={blockedReason}
          isLoading={isLoading}
          players={players}
          serverId={serverId}
          serverName={serverName}
        />
        <BansCard blockedReason={blockedReason} serverId={serverId} />
      </div>
    </div>
  );
}
