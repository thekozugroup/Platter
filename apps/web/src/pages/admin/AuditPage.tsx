import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import {
  AUDIT_ACTIONS,
  formatRelativeTime,
  type AuditAction,
  type AuditEntry,
} from '@platter/shared';
import { Article } from 'pixelarticons/react/Article.js';
import { Download } from 'pixelarticons/react/Download.js';
import { Robot } from 'pixelarticons/react/Robot.js';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { PageAction, PageBody, PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useAuditLog, useExportAuditLog, useUsers, type AuditFilters } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * Every state-changing action, read as a sentence.
 *
 * `describeAudit` in `services/audit.ts` already turns an entry into the same kind of
 * sentence server-side, for the ndjson export and anywhere else the API narrates itself —
 * that function is not reachable from a browser bundle (it lives with Prisma and the rest of
 * the API), so the phrase table is kept here too, worded identically on purpose. A stored
 * action this build cannot describe is dropped by the API before it reaches this screen
 * (`toAuditEntry` returns null for it), so this table has no "unknown action" branch to get
 * wrong quietly.
 *
 * The one signal this screen exists to surface: an entry whose `metadata.via` is `"mcp"` was
 * not typed by a person. `mcp/tools.ts` stamps that onto every write an MCP tool call makes,
 * naming the tool and the API key alongside it — the same human account is still the actor
 * (whoever's key it was), but the hand on the keyboard was an agent's, and that is the
 * distinction an operator reading this log actually needs.
 */

const AUDIT_PHRASES: Record<AuditAction, string> = {
  'auth.login': 'signed in',
  'auth.login_failed': 'failed to sign in',
  'auth.logout': 'signed out',
  'auth.password_changed': 'changed their password',
  'auth.totp_enabled': 'turned on two-factor authentication',
  'auth.totp_disabled': 'turned off two-factor authentication',
  'apikey.created': 'created the API key {target}',
  'apikey.revoked': 'revoked the API key {target}',
  'user.created': 'created the account {target}',
  'user.updated': 'updated the account {target}',
  'user.deleted': 'deleted the account {target}',
  'user.suspended': 'suspended the account {target}',
  'server.created': 'created the server {target}',
  'server.updated': 'updated the server {target}',
  'server.deleted': 'deleted the server {target}',
  'server.reinstalled': 'reinstalled the server {target}',
  'server.suspended': 'suspended the server {target}',
  'server.power': 'sent a power action to {target}',
  'server.command': 'ran a console command on {target}',
  'server.subuser_added': 'gave someone access to {target}',
  'server.subuser_updated': 'changed permissions on {target}',
  'server.subuser_removed': 'removed someone from {target}',
  'file.written': 'edited a file on {target}',
  'file.deleted': 'deleted files on {target}',
  'file.renamed': 'renamed a file on {target}',
  'file.uploaded': 'uploaded files to {target}',
  'backup.created': 'created the backup {target}',
  'backup.restored': 'restored the backup {target}',
  'backup.deleted': 'deleted the backup {target}',
  'schedule.created': 'created the schedule {target}',
  'schedule.updated': 'updated the schedule {target}',
  'schedule.deleted': 'deleted the schedule {target}',
  'schedule.executed': 'ran the schedule {target}',
  'node.created': 'added the node {target}',
  'node.updated': 'updated the node {target}',
  'node.deleted': 'removed the node {target}',
  'ai.provision_proposed': 'asked the assistant to design a server',
  'ai.fix_applied': 'applied an assistant suggestion to {target}',
  'settings.updated': 'changed Platter settings',
};

/** Short verb phrases for the filter list — the sentences above are for reading a row, these
 *  are for scanning a dropdown of 38 of them. */
const ACTION_FILTER_LABEL: Record<AuditAction, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Password changed',
  'auth.totp_enabled': 'Two-factor turned on',
  'auth.totp_disabled': 'Two-factor turned off',
  'apikey.created': 'API key created',
  'apikey.revoked': 'API key revoked',
  'user.created': 'Account created',
  'user.updated': 'Account updated',
  'user.deleted': 'Account deleted',
  'user.suspended': 'Account suspended',
  'server.created': 'Server created',
  'server.updated': 'Server updated',
  'server.deleted': 'Server deleted',
  'server.reinstalled': 'Server reinstalled',
  'server.suspended': 'Server suspended',
  'server.power': 'Power action',
  'server.command': 'Console command',
  'server.subuser_added': 'Collaborator added',
  'server.subuser_updated': 'Collaborator permissions changed',
  'server.subuser_removed': 'Collaborator removed',
  'file.written': 'File edited',
  'file.deleted': 'File deleted',
  'file.renamed': 'File renamed',
  'file.uploaded': 'File uploaded',
  'backup.created': 'Backup created',
  'backup.restored': 'Backup restored',
  'backup.deleted': 'Backup deleted',
  'schedule.created': 'Schedule created',
  'schedule.updated': 'Schedule updated',
  'schedule.deleted': 'Schedule deleted',
  'schedule.executed': 'Schedule ran',
  'node.created': 'Node added',
  'node.updated': 'Node updated',
  'node.deleted': 'Node removed',
  'ai.provision_proposed': 'AI design proposed',
  'ai.fix_applied': 'AI suggestion applied',
  'settings.updated': 'Settings changed',
};

function actorFor(entry: AuditEntry): string {
  return entry.actorName ?? (entry.actorId === null ? 'Platter' : 'A deleted account');
}

function phraseFor(entry: AuditEntry): string {
  const target = entry.targetName ?? entry.targetId ?? 'it';
  const base = AUDIT_PHRASES[entry.action].replace('{target}', target);

  if (entry.action === 'server.power') {
    const power = entry.metadata['action'];
    if (typeof power === 'string' && power.length > 0) return `sent ${power} to ${target}`;
  } else if (entry.action === 'file.written' || entry.action === 'file.renamed') {
    const path = entry.metadata['path'];
    if (typeof path === 'string' && path.length > 0) {
      return `${entry.action === 'file.written' ? 'edited' : 'renamed'} ${path} on ${target}`;
    }
  }
  return base;
}

function sentenceFor(entry: AuditEntry): string {
  return `${actorFor(entry)} ${phraseFor(entry)}.`;
}

/** The one honest, backend-emitted signal that an MCP tool call — not a person — made this
 *  write. See `auditVia` in `mcp/tools.ts`. */
function isAgentEntry(entry: AuditEntry): boolean {
  return entry.metadata['via'] === 'mcp';
}

function agentDetail(entry: AuditEntry): string {
  const tool = entry.metadata['tool'];
  const keyPrefix = entry.metadata['apiKeyPrefix'];
  const parts = ['via MCP'];
  if (typeof tool === 'string' && tool.length > 0) parts.push(tool);
  if (typeof keyPrefix === 'string' && keyPrefix.length > 0) parts.push(`key ${keyPrefix}`);
  return parts.join(' · ');
}

function AgentBadge() {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-pill border border-pill-border',
        'bg-pill px-1.5 align-middle text-caption-2 font-medium text-label-secondary',
      )}
    >
      <Robot aria-hidden className="size-3" />
      Agent
    </span>
  );
}

// ---------------------------------------------------------------------------------------

function startOfDayIso(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function endOfDayIso(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const actorId = searchParams.get('actorId') ?? '';
  const action = (searchParams.get('action') as AuditAction | null) ?? '';
  const sinceDay = searchParams.get('since') ?? '';
  const untilDay = searchParams.get('until') ?? '';

  function updateParams(changes: Record<string, string>) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }

  const filters: AuditFilters = {
    ...(actorId ? { actorId } : {}),
    ...(action ? { action } : {}),
    ...(startOfDayIso(sinceDay) ? { since: startOfDayIso(sinceDay) } : {}),
    ...(endOfDayIso(untilDay) ? { until: endOfDayIso(untilDay) } : {}),
  };
  const filtered = Object.keys(filters).length > 0;

  const audit = useAuditLog(filters);
  const exportLog = useExportAuditLog(filters);
  const actors = useUsers({ perPage: 100 });

  const rows = audit.data?.pages.flatMap((page) => page.data) ?? [];
  const total = audit.data?.pages[0]?.meta.total ?? 0;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!audit.hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !audit.isFetchingNextPage) void audit.fetchNextPage();
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audit.hasNextPage, audit.isFetchingNextPage]);

  const dateError =
    sinceDay && untilDay && sinceDay > untilDay ? 'The start of the range is after its end.' : undefined;

  return (
    <>
      <PageHeader
        actions={
          <PageAction
            aria-describedby={rows.length === 0 ? 'audit-export-hint' : undefined}
            disabled={rows.length === 0}
            isLoading={exportLog.isPending}
            onClick={() =>
              exportLog.mutate(undefined, {
                onError: (cause: unknown) =>
                  toast.create({
                    title: "Couldn't export the log",
                    description: errorMessage(cause),
                    type: 'error',
                  }),
              })
            }
          >
            <Download aria-hidden />
            Export
          </PageAction>
        }
        description="Every action anyone — or anything — has taken on this installation, newest first."
        title="Audit log"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel>Actor</FieldLabel>
            <NativeSelect
              className="w-48 [&>select]:h-11"
              onChange={(event) => updateParams({ actorId: event.target.value })}
              size="lg"
              value={actorId}
            >
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {(actors.data?.data ?? []).map((candidate) => (
                <NativeSelectOption key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field className="w-auto">
            <FieldLabel>Action</FieldLabel>
            <NativeSelect
              className="w-56 [&>select]:h-11"
              onChange={(event) => updateParams({ action: event.target.value })}
              size="lg"
              value={action}
            >
              <NativeSelectOption value="">Any action</NativeSelectOption>
              {AUDIT_ACTIONS.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {ACTION_FILTER_LABEL[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field className="w-auto" invalid={Boolean(dateError)}>
            <FieldLabel>From</FieldLabel>
            <Input
              aria-describedby={dateError ? 'audit-date-error' : undefined}
              className="h-11 w-40"
              max={untilDay || undefined}
              onChange={(event) => updateParams({ since: event.target.value })}
              type="date"
              value={sinceDay}
            />
          </Field>

          <Field className="w-auto" invalid={Boolean(dateError)}>
            <FieldLabel>To</FieldLabel>
            <Input
              aria-describedby={dateError ? 'audit-date-error' : undefined}
              className="h-11 w-40"
              min={sinceDay || undefined}
              onChange={(event) => updateParams({ until: event.target.value })}
              type="date"
              value={untilDay}
            />
          </Field>

          {filtered ? (
            <Button
              className="h-11 rounded-button px-4 text-subhead font-medium"
              onClick={() => updateParams({ actorId: '', action: '', since: '', until: '' })}
              variant="ghost"
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        {dateError ? (
          <p className="text-caption text-danger" id="audit-date-error" role="alert">
            {dateError}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="sr-only" id="audit-export-hint">
            There is nothing to export yet.
          </p>
        ) : null}
      </PageHeader>

      <PageBody>
        {audit.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-10 rounded-sm" />
            <Skeleton className="h-10 rounded-sm" />
            <Skeleton className="h-10 rounded-sm" />
            <span aria-live="polite" className="sr-only" role="status">
              Loading the audit log
            </span>
          </div>
        ) : null}

        {audit.isError ? (
          <ErrorState
            error={audit.error}
            isRetrying={audit.isFetching}
            onRetry={() => void audit.refetch()}
            title="Couldn’t load the audit log"
          />
        ) : null}

        {audit.isSuccess && rows.length === 0 && filtered ? (
          <EmptyState
            action={{
              label: 'Clear the filters',
              onClick: () => updateParams({ actorId: '', action: '', since: '', until: '' }),
            }}
            description="Nothing matches these filters. Widen the search, or clear it to see every entry."
            title="Nothing matches that"
          />
        ) : null}

        {audit.isSuccess && rows.length === 0 && !filtered ? (
          <EmptyState
            description="Every action anyone takes — a restart, a file edit, a backup, a change made through an AI agent — is recorded here with who did it and when."
            icon={<Article />}
            title="Nothing has happened yet"
          />
        ) : null}

        {audit.isSuccess && rows.length > 0 ? (
          <div className="flex flex-col gap-4">
            <p aria-live="polite" className="text-caption text-label-secondary" role="status">
              {`Showing ${rows.length} of ${total} entr${total === 1 ? 'y' : 'ies'}`}
              {filtered ? ' matching your filters' : ''}
            </p>

            <ul className="flex flex-col divide-y divide-separator border-y border-separator">
              {rows.map((entry) => {
                const agent = isAgentEntry(entry);
                return (
                  <li
                    className={cn('flex flex-col gap-1 px-2 py-3', agent && 'bg-fill-tertiary')}
                    key={entry.id}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 flex-1 text-subhead text-label">
                        {agent ? <AgentBadge /> : null}
                        {agent ? ' ' : null}
                        {sentenceFor(entry)}
                      </p>
                      <time
                        className="tabular shrink-0 text-caption text-label-secondary"
                        dateTime={entry.createdAt}
                        title={new Date(entry.createdAt).toLocaleString()}
                      >
                        {formatRelativeTime(entry.createdAt)}
                      </time>
                    </div>
                    {agent ? (
                      <p className="font-mono text-caption text-label-tertiary">{agentDetail(entry)}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div ref={sentinelRef} />

            {audit.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  className="h-11 rounded-button px-5 text-subhead font-medium"
                  isLoading={audit.isFetchingNextPage}
                  onClick={() => void audit.fetchNextPage()}
                  variant="outline"
                >
                  Load older activity
                </Button>
              </div>
            ) : (
              <p className="text-center text-caption text-label-tertiary">
                That is everything for this filter.
              </p>
            )}
          </div>
        ) : null}
      </PageBody>
    </>
  );
}
