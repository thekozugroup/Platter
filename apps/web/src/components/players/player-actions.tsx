import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import type { CommandResult, RosterUnavailableReason } from '@/hooks/use-players.js';
import { api, errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * Everything that changes a player's standing on a server.
 *
 * This module owns the player API contract for the whole feature — the wire types, the query
 * keys and the mutations — because three components need them and a circular import between
 * a list and its rows is not worth the tidiness.
 *
 * Two rules run through all of it:
 *
 * - **Nothing destructive happens without naming the person.** "Ban this player?" is not a
 *   confirmation. "Ban Notch from Survival SMP? They are disconnected immediately and cannot
 *   rejoin until you pardon them" is.
 * - **The result is whatever the server said, verbatim.** Every one of these is a console
 *   command underneath, and Minecraft answers `kick` for a player who left thirty seconds ago
 *   with "No player was found" on a perfectly successful HTTP 200. Reporting "Kicked Notch"
 *   there would be a lie the interface tells to look tidy, so the server's own reply is what
 *   gets shown.
 */

// ---------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------

/*
 * The response shapes, the query keys and the read hooks live in `hooks/use-players.ts`,
 * which mirrors `apps/api/src/routes/players.ts` (none of it is in `@platter/shared` — the
 * route declares its schemas inline). Re-declaring any of it here would give the same
 * endpoints two cache keys, and a ban issued on this screen would leave the whitelist card
 * showing stale data on the next one.
 *
 * What this module adds on top is the part the hooks deliberately leave out: a single
 * mutation that reports **what the server actually said**.
 */
export type {
  BanEntry,
  BansState,
  CommandResult,
  PlayerRecord,
  PlayerRoster,
  RosterUnavailableReason,
  WhitelistState,
} from '@/hooks/use-players.js';

/** The root of one server's player cache. Invalidating it refreshes the whole screen. */
export function playersRootKey(serverId: string) {
  return ['servers', serverId, 'players'] as const;
}

const encode = (value: string): string => encodeURIComponent(value);

/**
 * Thin request functions rather than the mutation hooks in `use-players.ts`. Every action on
 * this screen has to funnel through one mutation so a single toast can quote the server's
 * reply, and nine separate `useMutation`s cannot be composed into that.
 */
export const playerApi = {
  kick: (serverId: string, name: string, reason: string | null) =>
    api.post<CommandResult>(`/servers/${serverId}/players/${encode(name)}/kick`, {
      ...(reason ? { reason } : {}),
    }),
  ban: (serverId: string, name: string, reason: string | null) =>
    api.post<CommandResult>(`/servers/${serverId}/players/${encode(name)}/ban`, {
      ...(reason ? { reason } : {}),
    }),
  pardon: (serverId: string, name: string) =>
    api.post<CommandResult>(`/servers/${serverId}/players/${encode(name)}/pardon`),
  setOperator: (serverId: string, name: string, op: boolean) =>
    api.put<CommandResult>(`/servers/${serverId}/players/${encode(name)}/op`, { op }),

  whitelistAdd: (serverId: string, name: string) =>
    api.post<CommandResult>(`/servers/${serverId}/players/whitelist`, { name }),
  whitelistRemove: (serverId: string, name: string) =>
    api.delete<CommandResult>(`/servers/${serverId}/players/whitelist/${encode(name)}`),
  setWhitelistEnabled: (serverId: string, enabled: boolean) =>
    api.put<CommandResult>(`/servers/${serverId}/players/whitelist`, { enabled }),

  banIp: (serverId: string, ip: string, reason: string | null) =>
    api.post<CommandResult>(`/servers/${serverId}/players/bans/ip`, {
      ip,
      ...(reason ? { reason } : {}),
    }),
  pardonIp: (serverId: string, ip: string) =>
    api.delete<CommandResult>(`/servers/${serverId}/players/bans/ip/${encode(ip)}`),
};

// ---------------------------------------------------------------------------------------
// Unavailability, said in words
// ---------------------------------------------------------------------------------------

export const ROSTER_UNAVAILABLE_TITLE: Record<RosterUnavailableReason, string> = {
  not_supported: 'This game has no live player list',
  not_enabled: 'RCON is switched off',
  no_password: 'RCON has no password yet',
  offline: 'The server is not running',
  unreachable: 'Platter can’t reach RCON',
  timeout: 'RCON did not answer in time',
  auth_failed: 'RCON rejected the password',
  protocol_error: 'RCON answered with something unreadable',
};

export const ROSTER_UNAVAILABLE_FIX: Record<RosterUnavailableReason, string> = {
  not_supported:
    'This blueprint exposes no way to read who is playing, so everything below is what Platter recorded from the console.',
  not_enabled:
    'Turn on ENABLE_RCON in Settings and restart the server. Kicks, bans and the whitelist all travel over RCON.',
  no_password:
    'Set an RCON password in Settings and restart. Platter generates one on first start, so this usually clears itself.',
  offline:
    'Start the server to manage players. Everything below is the history Platter already has.',
  unreachable:
    'Check the container is up and the RCON port is mapped. The console tab usually says why.',
  timeout: 'The server may be busy or mid-restart. Try again in a moment.',
  auth_failed:
    'The password Platter holds does not match the server’s. Update it in Settings and restart.',
  protocol_error: 'Check the server log — a plugin may be sitting in front of RCON.',
};

/** One sentence for a disabled action, given why the roster is unavailable. */
export function blockedReasonFor(unavailable: RosterUnavailableReason | null): string | null {
  if (unavailable === null) return null;
  return `${ROSTER_UNAVAILABLE_TITLE[unavailable]}. ${ROSTER_UNAVAILABLE_FIX[unavailable]}`;
}

// ---------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------

export interface PlayerCommand {
  /** Stable per button, so only the pressed control shows a spinner. */
  id: string;
  /** Past tense, naming the player: "Kicked Notch". */
  done: string;
  /** "Couldn’t kick Notch". */
  failed: string;
  run: () => Promise<CommandResult>;
}

/** The server's own reply, or an honest note that there wasn't one. */
export function describeOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 0
    ? `The server said: ${trimmed}`
    : 'The server accepted it without a reply.';
}

export type PlayerCommandMutation = UseMutationResult<CommandResult, unknown, PlayerCommand>;

export function usePlayerCommand(serverId: string): PlayerCommandMutation {
  const queryClient = useQueryClient();

  return useMutation<CommandResult, unknown, PlayerCommand>({
    mutationFn: (command) => command.run(),
    onSuccess: (result, command) => {
      toast.create({
        title: command.done,
        description: describeOutput(result.output),
        type: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: playersRootKey(serverId) });
    },
    onError: (error, command) => {
      toast.create({
        title: command.failed,
        description: errorMessage(error),
        type: 'error',
      });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------------------

/**
 * Under 768px a row of five buttons is unusable, so the actions move into a sheet. This is
 * read rather than rendered twice: two copies of every button would put two of each into the
 * accessibility tree, and a screen reader would hear "Kick Notch" twice on every row.
 */
export function useMediaQuery(query: string): boolean {
  const [subscribe, getSnapshot] = useMemo(() => {
    const list =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query)
        : null;

    return [
      (onStoreChange: () => void) => {
        if (!list) return () => undefined;
        list.addEventListener('change', onStoreChange);
        return () => list.removeEventListener('change', onStoreChange);
      },
      () => list?.matches ?? false,
    ] as const;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useCompactViewport(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

// ---------------------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------------------

export interface PlayerTarget {
  name: string;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}

interface ConfirmSpec {
  title: string;
  body: ReactNode;
  button: string;
  destructive: boolean;
  /** Adds an optional reason field, which the server shows the player. */
  withReason?: boolean;
}

interface ActionSpec {
  id: string;
  label: string;
  destructive: boolean;
  done: string;
  failed: string;
  run: (reason: string | null) => Promise<CommandResult>;
  confirm?: ConfirmSpec;
  /** Non-null disables the control and is shown as the reason. */
  blocked: string | null;
}

function buildActions(
  serverId: string,
  serverName: string,
  player: PlayerTarget,
  blockedReason: string | null,
): ActionSpec[] {
  const { name } = player;

  const actions: ActionSpec[] = [
    {
      id: 'kick',
      label: 'Kick',
      destructive: true,
      done: `Kicked ${name}`,
      failed: `Couldn’t kick ${name}`,
      run: (reason) => playerApi.kick(serverId, name, reason),
      blocked: blockedReason ?? (player.online ? null : 'They are not online right now.'),
      confirm: {
        title: `Kick ${name}?`,
        destructive: true,
        withReason: true,
        button: 'Kick them',
        body: (
          <>
            They are disconnected from{' '}
            <strong className="font-medium text-label">{serverName}</strong> immediately and can
            rejoin straight away. Nothing they built is affected.
          </>
        ),
      },
    },
    player.banned
      ? {
          id: 'pardon',
          label: 'Pardon',
          destructive: false,
          done: `Pardoned ${name}`,
          failed: `Couldn’t pardon ${name}`,
          run: () => playerApi.pardon(serverId, name),
          blocked: blockedReason,
        }
      : {
          id: 'ban',
          label: 'Ban',
          destructive: true,
          done: `Banned ${name}`,
          failed: `Couldn’t ban ${name}`,
          run: (reason) => playerApi.ban(serverId, name, reason),
          blocked: blockedReason,
          confirm: {
            title: `Ban ${name}?`,
            destructive: true,
            withReason: true,
            button: 'Ban them',
            body: (
              <>
                They are disconnected now and cannot rejoin{' '}
                <strong className="font-medium text-label">{serverName}</strong> until you pardon
                them. Their buildings and inventory stay where they are.
              </>
            ),
          },
        },
    player.op
      ? {
          id: 'deop',
          label: 'Remove operator',
          destructive: false,
          done: `${name} is no longer an operator`,
          failed: `Couldn’t change ${name}’s operator status`,
          run: () => playerApi.setOperator(serverId, name, false),
          blocked: blockedReason,
        }
      : {
          id: 'op',
          label: 'Make operator',
          destructive: false,
          done: `${name} is now an operator`,
          failed: `Couldn’t change ${name}’s operator status`,
          run: () => playerApi.setOperator(serverId, name, true),
          blocked: blockedReason,
          confirm: {
            title: `Make ${name} an operator?`,
            destructive: false,
            button: 'Make them an operator',
            body: (
              <>
                Operators can run any command on{' '}
                <strong className="font-medium text-label">{serverName}</strong> — change the world,
                ban other players, and grant operator to anyone else. Only do this for people you
                trust with the server itself.
              </>
            ),
          },
        },
    player.whitelisted
      ? {
          id: 'whitelist-remove',
          label: 'Remove from whitelist',
          destructive: false,
          done: `Removed ${name} from the whitelist`,
          failed: `Couldn’t remove ${name} from the whitelist`,
          run: () => playerApi.whitelistRemove(serverId, name),
          blocked: blockedReason,
        }
      : {
          id: 'whitelist-add',
          label: 'Add to whitelist',
          destructive: false,
          done: `Added ${name} to the whitelist`,
          failed: `Couldn’t add ${name} to the whitelist`,
          run: () => playerApi.whitelistAdd(serverId, name),
          blocked: blockedReason,
        },
  ];

  return actions;
}

// ---------------------------------------------------------------------------------------
// The UI
// ---------------------------------------------------------------------------------------

export interface PlayerActionsProps {
  serverId: string;
  serverName: string;
  player: PlayerTarget;
  /** Why nothing can be done right now — RCON off, server stopped. Null when all is well. */
  blockedReason: string | null;
  /** `inline` is a wrapped row of pills; `sheet` is one trigger opening a full-height panel. */
  variant: 'inline' | 'sheet';
  className?: string;
}

const ACTION_BUTTON = 'h-11 rounded-button px-4 text-subhead font-medium';

export function PlayerActions({
  serverId,
  serverName,
  player,
  blockedReason,
  variant,
  className,
}: PlayerActionsProps) {
  const command = usePlayerCommand(serverId);
  /*
   * Two pieces of state rather than one: `pending` outlives `open` so the dialog's content
   * is still mounted while it animates out, which is what lets Ark restore focus to the
   * button that opened it. Unmounting the whole dialog on confirm skips that.
   */
  const [pending, setPending] = useState<ActionSpec | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const actions = buildActions(serverId, serverName, player, blockedReason);

  function run(action: ActionSpec, withReason: string | null) {
    command.mutate({
      id: `${action.id}:${player.name}`,
      done: action.done,
      failed: action.failed,
      run: () => action.run(withReason),
    });
  }

  function start(action: ActionSpec) {
    if (action.confirm) {
      setReason('');
      setPending(action);
      setOpen(true);
      return;
    }
    run(action, null);
  }

  const confirmDialog = (
    <AlertDialog onOpenChange={(details) => setOpen(details.open)} open={open}>
      {pending?.confirm ? (
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              {pending.confirm.title}
            </AlertDialogTitle>
            <AlertDialogDescription>{pending.confirm.body}</AlertDialogDescription>
          </AlertDialogHeader>

          {pending.confirm.withReason ? (
            <AlertDialogBody>
              <Field>
                <FieldLabel>Reason</FieldLabel>
                <Input
                  className="h-11"
                  maxLength={200}
                  name="reason"
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Griefing spawn"
                  value={reason}
                />
                <FieldHelper>
                  Optional. {player.name} sees this on the disconnect screen.
                </FieldHelper>
              </Field>
            </AlertDialogBody>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel className={ACTION_BUTTON}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={ACTION_BUTTON}
              onClick={() => {
                const action = pending;
                const trimmed = reason.trim();
                setOpen(false);
                run(action, trimmed.length > 0 ? trimmed : null);
              }}
              variant={pending.confirm.destructive ? 'destructive' : 'default'}
            >
              {pending.confirm.button}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );

  const buttons = actions.map((action) => {
    const busy = command.isPending && command.variables?.id === `${action.id}:${player.name}`;
    const hintId = action.blocked ? `block-${action.id}-${slug(player.name)}` : undefined;

    const button = (
      <Button
        {...(hintId ? { 'aria-describedby': hintId } : {})}
        className={cn(
          ACTION_BUTTON,
          action.destructive && 'text-danger',
          variant === 'sheet' && 'w-full justify-start',
        )}
        disabled={Boolean(action.blocked)}
        isLoading={busy}
        onClick={() => start(action)}
        size="lg"
        variant="outline"
      >
        {action.label}
      </Button>
    );

    if (variant === 'sheet') {
      return (
        <div className="flex flex-col gap-1" key={action.id}>
          {button}
          {action.blocked ? (
            <p className="text-caption text-label-tertiary" id={hintId}>
              {action.blocked}
            </p>
          ) : null}
        </div>
      );
    }

    // Inline, the reason cannot sit under the button without breaking the row. It is tied to
    // the control by `aria-describedby` for assistive tech, and the wrapper — which keeps its
    // own pointer events while the disabled button drops them — carries it as a tooltip.
    if (action.blocked) {
      return (
        <span className="inline-flex" key={action.id} title={action.blocked}>
          {button}
          <span className="sr-only" id={hintId}>
            {action.blocked}
          </span>
        </span>
      );
    }

    return <Fragment key={action.id}>{button}</Fragment>;
  });

  if (variant === 'sheet') {
    return (
      <>
        <Sheet>
          <SheetTrigger asChild>
            <Button className={cn(ACTION_BUTTON, className)} size="lg" variant="outline">
              Manage
              <span className="sr-only"> {player.name}</span>
            </Button>
          </SheetTrigger>
          <SheetContent placement="bottom">
            <SheetHeader>
              <SheetTitle className="font-sans text-title-3 font-semibold">
                {player.name}
              </SheetTitle>
              <SheetDescription>
                {blockedReason ??
                  `Each of these sends a console command to ${serverName} and reports what it answered.`}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="flex flex-col gap-3 pb-6">{buttons}</SheetBody>
          </SheetContent>
        </Sheet>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <div className={cn('flex flex-wrap items-center gap-2', className)}>{buttons}</div>
      {confirmDialog}
    </>
  );
}

function slug(value: string): string {
  return value.replace(/\W+/g, '-').toLowerCase();
}
