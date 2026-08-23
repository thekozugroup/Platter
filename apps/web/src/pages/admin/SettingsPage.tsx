import type React from 'react';
import { useEffect, useState } from 'react';
import { LIMITS, formatCpu, formatMegabytes } from '@platter/shared';
import { CopyField } from '@/components/common/copy-field';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useSystemSettings, useUpdateStatus, useUpdateSystemSettings } from '@/hooks';
import { ApiError, errorMessage } from '@/lib/api-client.js';
import { useAuth, useSystemInfo } from '@/lib/auth.js';
import { cn } from '@/lib/utils';

/**
 * Instance-wide settings.
 *
 * Everything on this page is real: the two fields Platter actually lets an owner change today
 * (`GET`/`PATCH /system/settings` covers `siteName` and `motd`, nothing else), and read-only
 * reports of the things people expect a settings page to configure but that live in the
 * environment instead — registration, the resource limits every server is bound by, backup
 * rotation, and which AI/mod providers have a key. None of those has a working control here
 * because none has an API behind it yet; showing a switch that silently does nothing when
 * pressed would be worse than not showing one; this shows the true current state and, where
 * there is one, the environment variable that sets it, instead.
 */

const SECTION_TITLE = 'font-sans text-title-3 font-semibold';
const FIELD_HEIGHT = 'h-11';
const ACTION = 'h-11 rounded-button px-5 text-subhead font-medium';

function DisabledHint({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="text-caption text-label-tertiary" id={id}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------------------

function GeneralCard() {
  const { isOwner } = useAuth();
  const settings = useSystemSettings();
  const update = useUpdateSystemSettings();

  const [siteName, setSiteName] = useState('');
  const [motd, setMotd] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings.data) {
      setSiteName(settings.data.siteName);
      setMotd(settings.data.motd);
    }
  }, [settings.data]);

  const dirty = settings.data
    ? siteName !== settings.data.siteName || motd !== settings.data.motd
    : false;
  const lockedReason = isOwner
    ? undefined
    : 'Only the owner of this installation can change instance settings.';

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>General</CardTitle>
        <CardDescription>Shown in the browser tab and, if set, on the dashboard.</CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <div className="flex max-w-md flex-col gap-4">
            <Skeleton className="h-11 rounded-sm" />
            <Skeleton className="h-20 rounded-sm" />
          </div>
        ) : null}

        {settings.isError ? (
          <p className="text-subhead text-danger" role="alert">
            {errorMessage(settings.error)}
          </p>
        ) : null}

        {settings.isSuccess ? (
          <form
            className="flex max-w-md flex-col gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!dirty || lockedReason) return;
              update.mutate(
                { siteName: siteName.trim(), motd: motd.trim() },
                {
                  onSuccess: () => {
                    setFieldErrors({});
                    toast.create({ title: 'Settings saved', type: 'success' });
                  },
                  onError: (cause: unknown) => {
                    setFieldErrors(cause instanceof ApiError ? cause.fieldErrors : {});
                    toast.create({
                      title: "Couldn't save settings",
                      description: errorMessage(cause),
                      type: 'error',
                    });
                  },
                },
              );
            }}
          >
            <fieldset className="contents" disabled={Boolean(lockedReason)}>
              <FieldGroup>
                <Field invalid={Boolean(fieldErrors.siteName)} required>
                  <FieldLabel>Site name</FieldLabel>
                  <Input
                    className={FIELD_HEIGHT}
                    maxLength={80}
                    name="siteName"
                    onChange={(event) => setSiteName(event.target.value)}
                    value={siteName}
                  />
                  <FieldError>{fieldErrors.siteName}</FieldError>
                </Field>

                <Field invalid={Boolean(fieldErrors.motd)}>
                  <FieldLabel>Message of the day</FieldLabel>
                  <Textarea
                    maxLength={500}
                    name="motd"
                    onChange={(event) => setMotd(event.target.value)}
                    placeholder="Shown on the dashboard for everyone. Optional."
                    rows={3}
                    value={motd}
                  />
                  <FieldError>{fieldErrors.motd}</FieldError>
                </Field>
              </FieldGroup>
            </fieldset>

            <div className="flex items-center gap-3">
              <Button
                {...(dirty && !lockedReason ? {} : { 'aria-describedby': 'settings-save-hint' })}
                className={ACTION}
                disabled={!dirty || Boolean(lockedReason)}
                isLoading={update.isPending}
                size="lg"
                type="submit"
              >
                Save changes
              </Button>
              {lockedReason ? (
                <DisabledHint id="settings-save-hint">{lockedReason}</DisabledHint>
              ) : !dirty ? (
                <DisabledHint id="settings-save-hint">Nothing has changed yet.</DisabledHint>
              ) : null}
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function AccessCard() {
  const info = useSystemInfo();

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Access</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel>Open registration</FieldLabel>
              <FieldHelper>
                {info.data?.features.registrationEnabled
                  ? 'Anyone who can reach this installation can create their own account.'
                  : 'New accounts can only be created by an admin, from the Users page.'}{' '}
                Set with the <code className="font-mono">REGISTRATION_ENABLED</code> environment
                variable — change it in your compose file or <code className="font-mono">.env</code>
                , then restart Platter.
              </FieldHelper>
            </div>
            {info.isPending ? (
              <Skeleton className="h-6 w-11 rounded-full" />
            ) : (
              <Switch
                aria-describedby="registration-hint"
                checked={info.data?.features.registrationEnabled ?? false}
                className="hit-target"
                disabled
              />
            )}
          </Field>
          <span className="sr-only" id="registration-hint">
            Set by an environment variable; not editable here.
          </span>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

interface LimitRowProps {
  label: string;
  value: string;
}

function LimitRow({ label, value }: LimitRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-subhead text-label-secondary">{label}</dt>
      <dd className="tabular font-mono text-subhead text-label">{value}</dd>
    </div>
  );
}

function DefaultsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Defaults and limits</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-separator">
          <LimitRow
            label="Memory per server"
            value={`${formatMegabytes(LIMITS.minMemoryMb)} – ${formatMegabytes(LIMITS.maxMemoryMb)}`}
          />
          <LimitRow
            label="Disk per server"
            value={`${formatMegabytes(LIMITS.minDiskMb)} – ${formatMegabytes(LIMITS.maxDiskMb)}`}
          />
          <LimitRow label="CPU per server" value={`Unlimited – ${formatCpu(LIMITS.maxCpuCores)}`} />
          <LimitRow label="Port range" value={`${LIMITS.minPort} – ${LIMITS.maxPort}`} />
          <LimitRow label="Password length" value={`${LIMITS.passwordMin} characters minimum`} />
          <LimitRow
            label="Upload size"
            value={formatMegabytes(LIMITS.maxUploadBytes / (1024 * 1024))}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function BackupsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Backups</CardTitle>
        <CardDescription>How long Platter keeps the backups it takes on its own.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="max-w-prose text-subhead text-label-secondary">
          Automatic backups — the ones a schedule takes — are rotated: once a server has too many,
          Platter deletes the oldest automatic one first. A backup you take by hand, or lock, is
          exempt and is kept until you delete it yourself. There is no per-instance retention
          setting to change yet; every server on this build follows the same rotation.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

type IntegrationState = 'configured' | 'not-configured' | 'unreported';

function IntegrationDot({ state }: { state: IntegrationState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        state === 'configured' && 'bg-success-dot',
        state === 'not-configured' && 'bg-neutral-status',
        state === 'unreported' && 'border border-separator-strong bg-transparent',
      )}
    />
  );
}

const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  configured: 'Connected',
  'not-configured': 'Not connected',
  unreported: 'Not reported here',
};

function IntegrationRow({
  name,
  description,
  envVar,
  state,
  footnote,
}: {
  name: string;
  description: string;
  /** Omitted when the integration needs no configuration at all. */
  envVar?: string;
  state: IntegrationState;
  footnote?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-subhead font-medium text-label">{name}</p>
        <span className="inline-flex items-center gap-1.5 text-subhead text-label-secondary">
          <IntegrationDot state={state} />
          {INTEGRATION_LABEL[state]}
        </span>
      </div>
      <p className="max-w-prose text-footnote text-label-secondary">{description}</p>
      {envVar === undefined ? null : (
        <p className="text-caption text-label-tertiary">
          Set with the <code className="font-mono">{envVar}</code> environment variable.
          {footnote ? ` ${footnote}` : ''}
        </p>
      )}
    </div>
  );
}

function UpdatesCard() {
  const status = useUpdateStatus();
  const settings = useSystemSettings();
  const update = useUpdateSystemSettings();
  const { user } = useAuth();
  const canEdit = user?.role === 'owner';

  const data = status.data;
  const command = 'docker compose pull && docker compose up -d';

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Updates</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {status.isPending ? (
          <Skeleton className="h-16 rounded-sm" />
        ) : (
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-subhead font-medium text-label">Version {data?.current ?? '—'}</p>
              <p className="text-footnote text-label-secondary">
                {data?.unavailable
                  ? data.unavailable
                  : data?.updateAvailable
                    ? `Version ${data.latest} is available.`
                    : 'Up to date.'}
              </p>
            </div>
            {data?.releaseUrl && data.updateAvailable ? (
              <Button asChild className="rounded-button" variant="outline">
                <a href={data.releaseUrl} rel="noreferrer noopener" target="_blank">
                  Release notes
                </a>
              </Button>
            ) : null}
          </div>
        )}

        {/*
          Platter does not replace its own container. Doing so means stopping the process
          that is serving this page, and a failure halfway leaves no interface to diagnose
          from — so the upgrade is two commands the operator runs, not a button that might
          strand them.
        */}
        {data?.updateAvailable ? (
          <div className="flex flex-col gap-2">
            <p className="text-footnote text-label-secondary">
              Run this in your install directory to upgrade. Servers keep running.
            </p>
            <CopyField label="Upgrade command" value={command} />
          </div>
        ) : null}

        <Field orientation="horizontal">
          <div className="flex flex-1 flex-col gap-1">
            <FieldLabel>Check for updates</FieldLabel>
            <FieldHelper>Contacts GitHub every few hours. No data is sent.</FieldHelper>
          </div>
          <Switch
            checked={settings.data?.updateChecks ?? true}
            className="hit-target"
            disabled={!canEdit || settings.isPending}
            onCheckedChange={({ checked }) =>
              update.mutate(
                { updateChecks: checked === true },
                {
                  onError: (cause: unknown) =>
                    toast.create({
                      title: 'Couldn’t change update checks',
                      description: errorMessage(cause),
                      type: 'error',
                    }),
                },
              )
            }
          />
        </Field>
      </CardContent>
    </Card>
  );
}

function IntegrationsCard() {
  const info = useSystemInfo();
  const sources = info.data?.modSources ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Integrations</CardTitle>
      </CardHeader>
      <CardContent>
        {info.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 rounded-sm" />
            <Skeleton className="h-16 rounded-sm" />
          </div>
        ) : (
          <div className="divide-y divide-separator">
            {/*
              No Anthropic row. Platter has no AI of its own to configure — the AI is whatever
              client you point at the MCP server, and it brings its own account. A key field
              here implied Platter would call a model on your behalf, which it does not.
            */}
            <IntegrationRow
              description="Mods and plugins, searched live. Nothing to set up."
              name="Modrinth"
              state={sources.includes('modrinth') ? 'configured' : 'not-configured'}
            />
            <IntegrationRow
              description="A second mod registry, alongside Modrinth."
              envVar="CURSEFORGE_API_KEY"
              name="CurseForge"
              state={sources.includes('curseforge') ? 'configured' : 'not-configured'}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

export function SettingsPage() {
  return (
    <>
      <PageHeader
        description="What applies to every account and every server on this installation."
        title="Settings"
      />
      <PageBody>
        <div className="flex flex-col gap-8">
          <GeneralCard />
          <AccessCard />
          <DefaultsCard />
          <BackupsCard />
          <UpdatesCard />
          <IntegrationsCard />
        </div>
      </PageBody>
    </>
  );
}
