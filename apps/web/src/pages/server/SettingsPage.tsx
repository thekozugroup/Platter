import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ServerPermission, ServerSubuser } from '@platter/shared';
import {
  DEFAULT_SUBUSER_PERMISSIONS,
  LIMITS,
  SERVER_PERMISSIONS,
  formatCpu,
  formatMegabytes,
  formatRelativeTime,
} from '@platter/shared';
import { Reload } from 'pixelarticons/react/Reload.js';
import { Trash } from 'pixelarticons/react/Trash.js';
import { avatarStyle } from '@/components/common/avatar-ink';
import { ErrorState } from '@/components/common/error-state';
import { PageBody } from '@/components/layout/page-header';
import {
  ResourceFields,
  clampResources,
  resourceBounds,
  type ResourceCapacity,
  type ResourceValue,
} from '@/components/servers/resource-fields';
import {
  VariableFields,
  variableErrors,
  type VariableValues,
} from '@/components/servers/variable-fields';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AdvancedOnly } from '@/components/common/advanced-disclosure';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  useAddSubuser,
  useDeleteServer,
  useNode,
  useNodeCapacity,
  useReinstallServer,
  useRemoveSubuser,
  useRenameServer,
  useSetAutoRestart,
  useSetAutoStart,
  useSubusers,
  useUpdateServer,
  useUpdateSubuserPermissions,
} from '@/hooks';
import { ApiError, errorMessage } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { serverNameProblem } from '@/lib/server-name.js';
import { useServerScope } from './ServerLayout';
import { cn } from '@/lib/utils';

/**
 * Everything about one server that is not its running state.
 *
 * Shark's `CardTitle` uses `font-heading`, which this theme maps to the pixel display face —
 * unreadable below about 20px — so every title here asks for `font-sans` explicitly.
 *
 * Two truths shape the copy on this page. First, a container's memory, CPU and environment are
 * fixed when it is created, so nothing in the limits or variables sections takes effect until
 * the next restart; saying so once per section beats a support thread about a setting that
 * "didn't work". Second, deletion takes the volume and every backup with it, which is why it
 * asks for the server's name rather than a click.
 */

/**
 * The CPU limit inside a sentence.
 *
 * `formatCpu` answers "Unlimited" for zero, which is right on its own line in the limits form
 * and produces "and unlimited of CPU" in prose. A limit and the absence of one are different
 * shapes of sentence, so they are written as different sentences.
 */
function cpuPhrase(cores: number): string {
  return cores <= 0 ? 'no CPU limit' : `${formatCpu(cores).toLowerCase()} of CPU`;
}

const SECTION_TITLE = 'font-sans text-title-3 font-semibold';
const ACTION = 'h-11 rounded-button px-5 text-subhead font-medium';
const FIELD = 'h-11';

function DisabledHint({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="text-caption text-label-tertiary" id={id}>
      {children}
    </span>
  );
}

// =======================================================================================

export function SettingsPage() {
  const { server, blueprint } = useServerScope();

  return (
    <PageBody className="flex flex-col gap-8">
      {/*
        Advanced mode gates *fields*, not whole cards, and these two cards are why.
        
        Hiding the limits card takes the memory slider with it — the thing an owner reaches
        for when a modpack needs more RAM — while the dashboard and the monitoring page keep
        quoting the allocation, so a throttled server has a cause the operator can read and
        cannot change. Hiding the variables card is worse: it holds the everyday game
        settings (difficulty, MOTD, whitelist) and "Verify accounts with Mojang", which is the
        only supported fix for friends whose accounts will not authenticate. Editing
        server.properties by hand does not survive a restart, so there would be no route at
        all. `VariableFields` already sorts its own advanced fields, which is the right
        granularity; the card belongs in both modes.
      */}
      <IdentityCard />
      <StartupCard />
      <LimitsCard />
      {blueprint && blueprint.variables.some((variable) => !variable.hidden) ? (
        <VariablesCard />
      ) : null}
      <PeopleCard />

      {/*
        Reinstall is normally an advanced tool, but it is also the fix for an install that
        failed — so a broken server shows it in either mode. Easy mode may not leave someone
        looking at a server that will not start with the repair hidden behind a preference
        they have no reason to suspect exists.
      */}
      <AdvancedOnly force={server.status === 'install_failed'}>
        <MaintenanceCard />
      </AdvancedOnly>

      <DangerCard key={server.id} />
    </PageBody>
  );
}

// =======================================================================================

function IdentityCard() {
  const { server } = useServerScope();
  const rename = useRenameServer(server.id);
  const update = useUpdateServer(server.id);

  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(server.name);
    setDescription(server.description);
  }, [server.name, server.description]);

  const dirty = name !== server.name || description !== server.description;
  const pending = rename.isPending || update.isPending;

  /*
   * A rejected submit must leave the keyboard where it was. Without this the browser's
   * focus falls to `<body>` the moment the button disables — the optimistic rename briefly
   * makes the form clean — and the next Tab restarts at "Skip to content".
   */
  const rejectName = (problem: string) => {
    setFieldErrors({ name: problem });
    nameRef.current?.focus();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Name and description</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-lg"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setFieldErrors({});

            const onError = (cause: unknown) => {
              const fields = cause instanceof ApiError ? cause.fieldErrors : {};
              setFieldErrors(fields);
              if (fields.name) nameRef.current?.focus();
              toast.create({
                title: 'Couldn’t save that',
                description: errorMessage(cause),
                type: 'error',
              });
            };

            // The rename is optimistic — the sidebar, the header and every card take the new
            // name immediately — so a name the API will certainly refuse has to be caught
            // here. Sending it would flash a nameless server across the whole shell.
            if (name !== server.name) {
              const problem = serverNameProblem(name);
              if (problem) {
                rejectName(problem);
                return;
              }
              rename.mutate(name.trim(), { onError });
            }
            if (description !== server.description) {
              update.mutate(
                { description: description.trim() },
                {
                  onSuccess: () => toast.create({ title: 'Saved', type: 'success' }),
                  onError,
                },
              );
            } else if (name !== server.name) {
              toast.create({ title: 'Saved', type: 'success' });
            }
          }}
        >
          <FieldGroup>
            <Field invalid={Boolean(fieldErrors.name)} required>
              <FieldLabel>Name</FieldLabel>
              <Input
                className={FIELD}
                maxLength={LIMITS.serverNameMax}
                name="name"
                onChange={(event) => setName(event.target.value)}
                ref={nameRef}
                value={name}
              />
              <FieldError>{fieldErrors.name}</FieldError>
            </Field>

            <Field invalid={Boolean(fieldErrors.description)}>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                className="min-h-24"
                maxLength={500}
                name="description"
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
              <FieldHelper>Optional. Shown on the dashboard card.</FieldHelper>
              <FieldError>{fieldErrors.description}</FieldError>
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                {...(dirty ? {} : { 'aria-describedby': 'identity-save-hint' })}
                className={ACTION}
                disabled={!dirty}
                isLoading={pending}
                size="lg"
                type="submit"
              >
                Save changes
              </Button>
              {!dirty ? (
                <DisabledHint id="identity-save-hint">Nothing has changed yet.</DisabledHint>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

// =======================================================================================

function StartupCard() {
  const { server } = useServerScope();
  const setAutoStart = useSetAutoStart(server.id);
  const setAutoRestart = useSetAutoRestart(server.id);

  const onError = (label: string) => (cause: unknown) =>
    toast.create({ title: label, description: errorMessage(cause), type: 'error' });

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Starting and restarting</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-6">
          <Field orientation="horizontal">
            <FieldLabel className="flex-1">Start with Platter</FieldLabel>
            <Switch
              checked={server.autoStart}
              className="hit-target"
              onCheckedChange={({ checked }) =>
                setAutoStart.mutate(checked === true, {
                  onError: onError('Couldn’t change auto-start'),
                })
              }
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel className="flex-1">Restart after a crash</FieldLabel>
            <Switch
              checked={server.autoRestart}
              className="hit-target"
              onCheckedChange={({ checked }) =>
                setAutoRestart.mutate(checked === true, {
                  onError: onError('Couldn’t change auto-restart'),
                })
              }
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

// =======================================================================================

function LimitsCard() {
  const { server, blueprint } = useServerScope();
  const { isAdmin } = useAuth();
  const update = useUpdateServer(server.id);

  // Node figures are admin-only. Asking for them as a member would just log a 403 per mount,
  // so members get the blueprint's own bounds and a note saying why.
  const nodeId = isAdmin ? server.nodeId : undefined;
  const node = useNode(nodeId);
  const capacityQuery = useNodeCapacity(nodeId, { refetchInterval: false });

  const capacity = useMemo<ResourceCapacity | null>(() => {
    const snapshot = capacityQuery.data;
    if (!snapshot) return null;
    /*
     * "Free" has to include what this server already holds, or the sliders could not even
     * stay where they are — the node counts this server's current allocation as spent.
     */
    return {
      nodeName: node.data?.name ?? 'this node',
      memoryFreeMb: Math.max(
        0,
        snapshot.memoryTotalMb - snapshot.memoryAllocatedMb + server.limits.memoryMb,
      ),
      diskFreeMb: Math.max(
        0,
        snapshot.diskTotalMb - snapshot.diskAllocatedMb + server.limits.diskMb,
      ),
      cpuCores: snapshot.cpuCores,
    };
  }, [capacityQuery.data, node.data, server.limits.memoryMb, server.limits.diskMb]);

  const [value, setValue] = useState<ResourceValue>({
    memoryMb: server.limits.memoryMb,
    diskMb: server.limits.diskMb,
    cpuCores: server.limits.cpuCores,
  });

  useEffect(() => {
    setValue({
      memoryMb: server.limits.memoryMb,
      diskMb: server.limits.diskMb,
      cpuCores: server.limits.cpuCores,
    });
  }, [server.limits.memoryMb, server.limits.diskMb, server.limits.cpuCores]);

  const bounds = blueprint ? resourceBounds(blueprint, capacity) : null;
  const dirty =
    value.memoryMb !== server.limits.memoryMb ||
    value.diskMb !== server.limits.diskMb ||
    value.cpuCores !== server.limits.cpuCores;

  if (!blueprint || !bounds) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className={SECTION_TITLE}>Resource limits</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 rounded-md" />
          <span className="sr-only" role="status">
            Loading this game’s limits.
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Resource limits</CardTitle>
        <CardDescription>
          {formatMegabytes(server.limits.memoryMb)} of memory,{' '}
          {formatMegabytes(server.limits.diskMb)} of disk and {cpuPhrase(server.limits.cpuCores)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Alert variant="warning">
          <AlertTitle className="font-sans">Takes effect on the next restart</AlertTitle>
          <AlertDescription>
            Docker sets these when it creates the container, so a running server keeps its old
            limits until you stop and start it. Saving here does not restart it for you.
          </AlertDescription>
        </Alert>

        <ResourceFields
          blueprint={blueprint}
          capacity={capacity}
          onChange={(next) => setValue(clampResources(next, bounds))}
          value={value}
        />

        {capacityQuery.isError ? (
          <p className="text-caption text-label-tertiary">
            Couldn’t read the node’s free space, so these ranges are the blueprint’s rather than the
            node’s. The API still refuses anything that will not fit.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            {...(dirty ? {} : { 'aria-describedby': 'limits-save-hint' })}
            className={ACTION}
            disabled={!dirty}
            isLoading={update.isPending}
            onClick={() =>
              update.mutate(
                { limits: value },
                {
                  onSuccess: () =>
                    toast.create({
                      title: 'Limits saved',
                      description: 'Restart the server for them to apply.',
                      type: 'success',
                    }),
                  onError: (cause: unknown) =>
                    toast.create({
                      title: 'Couldn’t save the limits',
                      description: errorMessage(cause),
                      type: 'error',
                    }),
                },
              )
            }
            size="lg"
          >
            Save limits
          </Button>
          {!dirty ? (
            <DisabledHint id="limits-save-hint">Nothing has changed yet.</DisabledHint>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// =======================================================================================

function VariablesCard() {
  const { server, blueprint } = useServerScope();
  const update = useUpdateServer(server.id);

  const variables = useMemo(() => blueprint?.variables ?? [], [blueprint]);

  const [values, setValues] = useState<VariableValues>(() => ({ ...server.variables }));
  const [apiErrors, setApiErrors] = useState<Record<string, string>>({});

  useEffect(() => setValues({ ...server.variables }), [server.variables]);

  const localErrors = variableErrors(variables, values);
  const errors = { ...localErrors, ...apiErrors };
  const dirty = variables.some(
    (variable) => (values[variable.key] ?? '') !== (server.variables[variable.key] ?? ''),
  );
  const valid = Object.keys(localErrors).length === 0;

  if (!blueprint) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>{blueprint.name} settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Alert variant="warning">
          <AlertTitle className="font-sans">Takes effect on the next restart</AlertTitle>
          <AlertDescription>
            Environment variables are fixed when the container is created. Config files the
            blueprint owns are re-rendered on the next boot.
          </AlertDescription>
        </Alert>

        <VariableFields
          errors={errors}
          onChange={(key, next) => {
            setValues((previous) => ({ ...previous, [key]: next }));
            setApiErrors((previous) => {
              if (!(key in previous)) return previous;
              const { [key]: _removed, ...rest } = previous;
              return rest;
            });
          }}
          values={values}
          variables={variables}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            {...(dirty && valid ? {} : { 'aria-describedby': 'variables-save-hint' })}
            className={ACTION}
            disabled={!dirty || !valid}
            isLoading={update.isPending}
            onClick={() =>
              update.mutate(
                { variables: values },
                {
                  onSuccess: () => {
                    setApiErrors({});
                    toast.create({
                      title: 'Settings saved',
                      description: 'Restart the server for them to apply.',
                      type: 'success',
                    });
                  },
                  onError: (cause: unknown) => {
                    setApiErrors(cause instanceof ApiError ? cause.fieldErrors : {});
                    toast.create({
                      title: 'Couldn’t save the settings',
                      description: errorMessage(cause),
                      type: 'error',
                    });
                  },
                },
              )
            }
            size="lg"
          >
            Save settings
          </Button>
          {!dirty ? (
            <DisabledHint id="variables-save-hint">Nothing has changed yet.</DisabledHint>
          ) : !valid ? (
            <DisabledHint id="variables-save-hint">{Object.values(localErrors)[0]}</DisabledHint>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// =======================================================================================
// Subusers
// =======================================================================================

interface PermissionGroup {
  title: string;
  blurb: string;
  permissions: readonly { key: ServerPermission; label: string; detail: string }[];
}

/**
 * Twenty checkboxes in one column is an unanswerable question, so they are grouped by the
 * thing they act on and each one says what it actually lets a person do.
 */
const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    title: 'The server',
    blurb: 'The server and its details.',
    permissions: [
      {
        key: 'server.view',
        label: 'View',
        detail: 'See the server and its status. Everything else needs this.',
      },
      { key: 'server.update', label: 'Edit', detail: 'Rename it and change its description.' },
      {
        key: 'server.delete',
        label: 'Delete',
        detail: 'Destroy the server, its volume and its backups.',
      },
    ],
  },
  {
    title: 'Power',
    blurb: 'Turning it on and off.',
    permissions: [
      { key: 'power.start', label: 'Start', detail: 'Bring the server up.' },
      {
        key: 'power.stop',
        label: 'Stop',
        detail: 'Shut it down, and kill it if it will not stop.',
      },
      { key: 'power.restart', label: 'Restart', detail: 'Stop then start in one action.' },
    ],
  },
  {
    title: 'Console',
    blurb: 'Log output and commands.',
    permissions: [
      { key: 'console.read', label: 'Read', detail: 'Watch the live output and its scrollback.' },
      {
        key: 'console.write',
        label: 'Send commands',
        detail: 'Type straight into the game process. This includes op and ban.',
      },
    ],
  },
  {
    title: 'Files',
    blurb: 'The data volume.',
    permissions: [
      { key: 'files.read', label: 'Read', detail: 'Browse and download files.' },
      { key: 'files.write', label: 'Write', detail: 'Upload, edit, rename and extract.' },
      { key: 'files.delete', label: 'Delete', detail: 'Remove files and folders from the volume.' },
    ],
  },
  {
    title: 'Backups',
    blurb: 'Archives of the volume.',
    permissions: [
      { key: 'backups.read', label: 'View', detail: 'See the list and download archives.' },
      { key: 'backups.create', label: 'Create', detail: 'Take a new backup.' },
      {
        key: 'backups.restore',
        label: 'Restore',
        detail: 'Stop the server and put an archive back over the volume.',
      },
      {
        key: 'backups.delete',
        label: 'Delete',
        detail: 'Remove archives, and lock or unlock them.',
      },
    ],
  },
  {
    title: 'Schedules',
    blurb: 'Recurring tasks.',
    permissions: [
      {
        key: 'schedules.read',
        label: 'View',
        detail: 'See what is scheduled and when it last ran.',
      },
      { key: 'schedules.write', label: 'Manage', detail: 'Add, edit, pause and delete schedules.' },
    ],
  },
  {
    title: 'Settings',
    blurb: 'Limits, variables and reinstall.',
    permissions: [
      {
        key: 'settings.read',
        label: 'View',
        detail: 'See the limits and the blueprint’s variables.',
      },
      {
        key: 'settings.write',
        label: 'Change',
        detail: 'Edit limits and variables, and reinstall the server.',
      },
    ],
  },
  {
    title: 'AI',
    blurb: 'The assistant.',
    permissions: [
      {
        key: 'ai.use',
        label: 'Use the assistant',
        detail: 'Ask it about this server and accept its proposals.',
      },
    ],
  },
];

function PeopleCard() {
  const { server } = useServerScope();
  const subusers = useSubusers(server.id);
  const add = useAddSubuser(server.id);
  const updatePermissions = useUpdateSubuserPermissions(server.id);
  const removeSubuser = useRemoveSubuser(server.id);

  const [email, setEmail] = useState('');
  const [draftPermissions, setDraftPermissions] = useState<ServerPermission[]>([
    ...DEFAULT_SUBUSER_PERMISSIONS,
  ]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ServerSubuser | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const rows = subusers.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>People</CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-8">
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setFieldErrors({});
            add.mutate(
              { email: email.trim(), permissions: draftPermissions },
              {
                onSuccess: (subuser) => {
                  setEmail('');
                  setDraftPermissions([...DEFAULT_SUBUSER_PERMISSIONS]);
                  toast.create({
                    title: `${subuser.displayName} can now use ${server.name}`,
                    type: 'success',
                  });
                },
                onError: (cause: unknown) => {
                  setFieldErrors(cause instanceof ApiError ? cause.fieldErrors : {});
                  toast.create({
                    title: 'Couldn’t add them',
                    description: errorMessage(cause),
                    type: 'error',
                  });
                },
              },
            );
          }}
        >
          <Field className="max-w-sm" invalid={Boolean(fieldErrors.email)} required>
            <FieldLabel>Invite by email</FieldLabel>
            <Input
              className={FIELD}
              inputMode="email"
              name="subuserEmail"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ada@example.com"
              type="email"
              value={email}
            />
            <FieldHelper>They need an account on this Platter already.</FieldHelper>
            <FieldError>{fieldErrors.email}</FieldError>
          </Field>

          <PermissionPicker
            idPrefix="new-subuser"
            onChange={setDraftPermissions}
            value={draftPermissions}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              {...(email.trim() && draftPermissions.length > 0
                ? {}
                : { 'aria-describedby': 'subuser-add-hint' })}
              className={ACTION}
              disabled={email.trim().length === 0 || draftPermissions.length === 0}
              isLoading={add.isPending}
              size="lg"
              type="submit"
            >
              Add them
            </Button>
            {email.trim().length === 0 ? (
              <DisabledHint id="subuser-add-hint">Enter their email address.</DisabledHint>
            ) : draftPermissions.length === 0 ? (
              <DisabledHint id="subuser-add-hint">Select at least one permission.</DisabledHint>
            ) : null}
          </div>
        </form>

        <div className="flex flex-col gap-3 border-t border-separator pt-6">
          <h3 className="font-sans text-subhead font-semibold text-label">Who has access</h3>

          {subusers.isPending ? (
            <Skeleton className="h-16 rounded-sm" />
          ) : subusers.isError ? (
            <ErrorState
              error={subusers.error}
              onRetry={() => void subusers.refetch()}
              variant="inline"
            />
          ) : rows.length === 0 ? (
            <p className="text-subhead text-label-secondary">
              No one else has access to this server.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-separator border-y border-separator">
              {rows.map((subuser) => (
                <li className="flex flex-col gap-3 py-4" key={subuser.id}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-sm text-caption font-semibold"
                      style={avatarStyle(subuser.avatarColor)}
                    >
                      {subuser.displayName.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-subhead font-medium text-label">
                        {subuser.displayName}
                      </p>
                      <p className="truncate text-caption text-label-tertiary">
                        {subuser.email} · added {formatRelativeTime(subuser.createdAt)}
                      </p>
                    </div>
                    <Button
                      aria-expanded={expanded === subuser.id}
                      className="h-11 rounded-button px-4 text-subhead"
                      onClick={() => setExpanded(expanded === subuser.id ? null : subuser.id)}
                      variant="outline"
                    >
                      {expanded === subuser.id
                        ? 'Hide permissions'
                        : `${subuser.permissions.length} permissions`}
                    </Button>
                    <Button
                      className="h-11 rounded-button px-4 text-subhead text-danger"
                      onClick={() => setRemoving(subuser)}
                      variant="outline"
                    >
                      Remove
                    </Button>
                  </div>

                  {expanded === subuser.id ? (
                    <PermissionPicker
                      idPrefix={`subuser-${subuser.id}`}
                      onChange={(permissions) =>
                        updatePermissions.mutate(
                          { subuserId: subuser.id, permissions },
                          {
                            onError: (cause: unknown) =>
                              toast.create({
                                title: 'Couldn’t change their permissions',
                                description: errorMessage(cause),
                                type: 'error',
                              }),
                          },
                        )
                      }
                      value={subuser.permissions}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <AlertDialog
        onOpenChange={({ open }) => (open ? undefined : setRemoving(null))}
        open={removing !== null}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Remove {removing?.displayName} from {server.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose access immediately, including any console they have open right now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="text-subhead text-label-secondary">
            Their Platter account is untouched, and anything they created — backups, schedules,
            files — stays exactly where it is.
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className={ACTION}>Keep their access</AlertDialogCancel>
            <AlertDialogAction
              className={ACTION}
              isLoading={removeSubuser.isPending}
              onClick={() => {
                if (!removing) return;
                removeSubuser.mutate(removing.id, {
                  onSuccess: () => {
                    setRemoving(null);
                    toast.create({ title: `Removed ${removing.displayName}`, type: 'success' });
                  },
                  onError: (cause: unknown) =>
                    toast.create({
                      title: 'Couldn’t remove them',
                      description: errorMessage(cause),
                      type: 'error',
                    }),
                });
              }}
              variant="destructive"
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function PermissionPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: readonly ServerPermission[];
  onChange: (permissions: ServerPermission[]) => void;
  idPrefix: string;
}) {
  const held = new Set(value);

  function toggle(permission: ServerPermission, checked: boolean) {
    const next = new Set(held);
    if (checked) {
      next.add(permission);
      // Every other permission is meaningless without being able to see the server, so
      // ticking anything grants it rather than producing a silently broken invitation.
      next.add('server.view');
    } else {
      next.delete(permission);
    }
    onChange(SERVER_PERMISSIONS.filter((entry) => next.has(entry)));
  }

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 text-subhead font-medium text-label">Permissions</legend>
      <div className="grid gap-5 sm:grid-cols-2">
        {PERMISSION_GROUPS.map((group) => (
          <div className="flex flex-col gap-2" key={group.title}>
            <div>
              <p className="text-subhead font-medium text-label">{group.title}</p>
              <p className="text-caption text-label-tertiary">{group.blurb}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {group.permissions.map((permission) => {
                const id = `${idPrefix}-${permission.key}`;
                return (
                  <li className="flex items-start gap-2.5" key={permission.key}>
                    <Checkbox
                      aria-describedby={`${id}-detail`}
                      checked={held.has(permission.key)}
                      className="hit-target mt-0.5"
                      id={id}
                      onCheckedChange={({ checked }) => toggle(permission.key, checked === true)}
                    />
                    <div className="min-w-0">
                      <label className="text-footnote font-medium text-label" htmlFor={id}>
                        {permission.label}
                      </label>
                      <p className="text-caption text-label-tertiary" id={`${id}-detail`}>
                        {permission.detail}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

// =======================================================================================

function MaintenanceCard() {
  const { server, blueprint } = useServerScope();
  const reinstall = useReinstallServer(server.id);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Reinstall</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button
          className={cn(ACTION, 'w-fit')}
          onClick={() => setConfirming(true)}
          size="lg"
          variant="outline"
        >
          <Reload aria-hidden />
          Reinstall {server.name}
        </Button>

        <AlertDialog onOpenChange={({ open }) => setConfirming(open)} open={confirming}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-sans text-title-3 font-semibold">
                Reinstall {server.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The server is stopped and {blueprint?.name ?? 'the blueprint'}’s install script runs
                again from the top.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody className="flex flex-col gap-3 text-subhead text-label-secondary">
              <p>
                <strong className="font-medium text-label">Replaced:</strong> the server binary,
                launch scripts, and any file the blueprint marks as overwrite-on-install.
              </p>
              <p>
                <strong className="font-medium text-label">Kept:</strong> your world, your mods and
                plugins folder, and config files the blueprint only writes when missing.
              </p>
              <p>
                Take a backup first if you are not sure which side of that line a file falls on —
                this cannot be undone from here.
              </p>
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel className={ACTION}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={ACTION}
                isLoading={reinstall.isPending}
                onClick={() =>
                  reinstall.mutate(undefined, {
                    onSuccess: () => {
                      setConfirming(false);
                      toast.create({
                        title: `Reinstalling ${server.name}`,
                        description: 'Watch the console for the install output.',
                        type: 'success',
                      });
                    },
                    onError: (cause: unknown) =>
                      toast.create({
                        title: 'Couldn’t start the reinstall',
                        description: errorMessage(cause),
                        type: 'error',
                      }),
                  })
                }
                variant="destructive"
              >
                Reinstall it
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// =======================================================================================

function DangerCard() {
  const { server } = useServerScope();
  const navigate = useNavigate();
  const remove = useDeleteServer();

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const matches = typed.trim() === server.name;

  return (
    <Card className="border-danger/30">
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Delete this server</CardTitle>
        <CardDescription>
          Removes the container, the data volume and every backup. There is no undo and no retention
          period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          className={cn(ACTION, 'w-fit')}
          onClick={() => setOpen(true)}
          size="lg"
          variant="destructive"
        >
          <Trash aria-hidden />
          Delete {server.name}
        </Button>

        <AlertDialog onOpenChange={({ open: next }) => setOpen(next)} open={open}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-sans text-title-3 font-semibold">
                Delete {server.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Its world data, its config, its mods and every backup are deleted from the node.
                Nothing is archived first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody className="flex flex-col gap-4">
              <ul className="flex list-disc flex-col gap-1 ps-5 text-subhead text-label-secondary">
                <li>The container is stopped and removed.</li>
                <li>The data volume is destroyed, including the world.</li>
                <li>Every backup of this server is deleted with it.</li>
                <li>Its port allocation goes back to the node’s pool.</li>
              </ul>

              <Field>
                <FieldLabel>
                  Type <span className="font-mono text-label">{server.name}</span> to confirm
                </FieldLabel>
                <Input
                  autoComplete="off"
                  className={cn(FIELD, 'font-mono')}
                  name="confirmName"
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={server.name}
                  value={typed}
                />
                <FieldHelper>
                  Typing the name out is the point — it is the last chance to notice this is the
                  wrong server.
                </FieldHelper>
              </Field>
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel className={ACTION}>Keep it</AlertDialogCancel>
              <Button
                aria-describedby={matches ? undefined : 'delete-confirm-hint'}
                className={ACTION}
                disabled={!matches}
                isLoading={remove.isPending}
                onClick={() =>
                  remove.mutate(server.id, {
                    onSuccess: () => {
                      setOpen(false);
                      toast.create({ title: `${server.name} is being deleted`, type: 'success' });
                      void navigate('/servers');
                    },
                    onError: (cause: unknown) =>
                      toast.create({
                        title: 'Couldn’t delete it',
                        description: errorMessage(cause),
                        type: 'error',
                      }),
                  })
                }
                variant="destructive"
              >
                Delete this server
              </Button>
              {!matches ? (
                <span className="sr-only" id="delete-confirm-hint">
                  Type the server’s name exactly to enable this button.
                </span>
              ) : null}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
