import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiKey, SessionUser } from '@platter/shared';
import { formatRelativeTime } from '@platter/shared';
import { Lightbulb } from 'pixelarticons/react/Lightbulb.js';
import { Monitor } from 'pixelarticons/react/Monitor.js';
import { Moon } from 'pixelarticons/react/Moon.js';
import { CopyField } from '@/components/common/copy-field';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from '@/components/ui/password-input';
import { QrCode, QrCodeFrame } from '@/components/ui/qr-code';
import {
  SegmentGroup,
  SegmentGroupItem,
  SegmentGroupItemText,
} from '@/components/ui/segment-group';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { useTheme, type ThemePreference } from '@/lib/theme.js';
import { cn } from '@/lib/utils';

/**
 * Account settings: profile, password, two-factor, API keys and theme.
 *
 * Two moments here are irreversible and are labelled as such rather than glossed over — the
 * recovery codes and the API token are each shown exactly once, and changing the password
 * ends every session including this one.
 *
 * Shark's card, dialog and alert titles use `font-heading`, which this theme maps to the
 * pixel display face. That face is unreadable below about 20px, so every title on this page
 * explicitly asks for `font-sans` — copy that pattern.
 */

const FIELD_HEIGHT = 'h-11';
const SECTION_TITLE = 'font-sans text-title-3 font-semibold';
const ACTION = 'h-11 rounded-button px-5 text-subhead font-medium';

/**
 * A disabled control always says why. Wired through `aria-describedby` so the reason is not
 * only visible but reachable from the control itself.
 */
function DisabledHint({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="text-caption text-label-tertiary" id={id}>
      {children}
    </span>
  );
}

interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

const THEME_CHOICES: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
}> = [
  { value: 'light', label: 'Light', icon: Lightbulb },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

// ---------------------------------------------------------------------------------------

function ProfileCard({ user }: { user: SessionUser }) {
  const { setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (input: { displayName: string; email: string }) =>
      api.patch<SessionUser>('/auth/me', input),
    onSuccess: (updated) => {
      setUser(updated);
      setFieldErrors({});
      toast.create({ title: 'Profile saved', type: 'success' });
    },
    onError: (error: unknown) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors : {});
      toast.create({
        title: 'Could not save your profile',
        description: errorMessage(error),
        type: 'error',
      });
    },
  });

  const dirty = displayName !== user.displayName || email !== user.email;

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Profile</CardTitle>
        <CardDescription>
          Your name appears next to every action you take, including in the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-md"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ displayName: displayName.trim(), email: email.trim() });
          }}
        >
          <FieldGroup>
            <Field invalid={Boolean(fieldErrors.displayName)}>
              <FieldLabel>Display name</FieldLabel>
              <Input
                className={FIELD_HEIGHT}
                maxLength={64}
                name="displayName"
                onChange={(event) => setDisplayName(event.target.value)}
                value={displayName}
              />
              <FieldError>{fieldErrors.displayName}</FieldError>
            </Field>

            <Field invalid={Boolean(fieldErrors.email)}>
              <FieldLabel>Email</FieldLabel>
              <Input
                className={FIELD_HEIGHT}
                inputMode="email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
              <FieldHelper>This is what you sign in with.</FieldHelper>
              <FieldError>{fieldErrors.email}</FieldError>
            </Field>

            <div className="flex items-center gap-3">
              <Button
                {...(dirty ? {} : { 'aria-describedby': 'profile-save-hint' })}
                className={ACTION}
                disabled={!dirty}
                isLoading={mutation.isPending}
                size="lg"
                type="submit"
              >
                Save changes
              </Button>
              {!dirty ? (
                <DisabledHint id="profile-save-hint">Nothing has changed yet.</DisabledHint>
              ) : null}
            </div>
          </FieldGroup>
        </form>

        <dl className="mt-8 grid gap-4 border-t border-separator pt-6 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-label-tertiary">Username</dt>
            <dd className="mt-1 font-mono text-footnote text-label-secondary">{user.username}</dd>
          </div>
          <div>
            <dt className="text-caption text-label-tertiary">Role</dt>
            <dd className="mt-1 text-footnote capitalize text-label-secondary">{user.role}</dd>
          </div>
          <div>
            <dt className="text-caption text-label-tertiary">Member since</dt>
            <dd className="mt-1 text-footnote text-label-secondary" title={user.createdAt}>
              {formatRelativeTime(user.createdAt)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">User id</dt>
            <dd className="mt-1">
              <CopyField label="User id" value={user.id} variant="inline" />
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function PasswordCard() {
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<{ ok: true }>('/auth/password', input),
    onSuccess: () => {
      setFieldErrors({});
      setFormError(null);
      toast.create({
        title: 'Password changed',
        description: 'Every session was signed out, including this one.',
        type: 'success',
      });
      // The API revoked every refresh token. Pretending we are still signed in would just
      // fail on the next request, so end the session here and say why.
      void logout();
    },
    onError: (error: unknown) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors : {});
      setFormError(errorMessage(error));
    },
  });

  const incomplete = currentPassword.length === 0 || newPassword.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Password</CardTitle>
        <CardDescription>
          Changing it signs out every device, including this one. You will sign in again straight
          away.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-md"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ currentPassword, newPassword });
          }}
        >
          <FieldGroup>
            {formError ? (
              <p
                className="rounded-sm border border-danger/25 bg-danger-subtle px-3 py-2 text-subhead text-danger"
                role="alert"
              >
                {formError}
              </p>
            ) : null}

            <Field invalid={Boolean(fieldErrors.currentPassword)} required>
              <FieldLabel>Current password</FieldLabel>
              <PasswordInput size="lg">
                <PasswordInputGroup className={FIELD_HEIGHT}>
                  <PasswordInputInput
                    autoComplete="current-password"
                    name="currentPassword"
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    value={currentPassword}
                  />
                  <PasswordInputTrigger aria-label="Toggle password visibility" />
                </PasswordInputGroup>
              </PasswordInput>
              <FieldError>{fieldErrors.currentPassword}</FieldError>
            </Field>

            <Field invalid={Boolean(fieldErrors.newPassword)} required>
              <FieldLabel>New password</FieldLabel>
              <PasswordInput size="lg">
                <PasswordInputGroup className={FIELD_HEIGHT}>
                  <PasswordInputInput
                    autoComplete="new-password"
                    name="newPassword"
                    onChange={(event) => setNewPassword(event.target.value)}
                    value={newPassword}
                  />
                  <PasswordInputTrigger aria-label="Toggle password visibility" />
                </PasswordInputGroup>
              </PasswordInput>
              <FieldHelper>At least 12 characters. Length beats symbols.</FieldHelper>
              <FieldError>{fieldErrors.newPassword}</FieldError>
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                {...(incomplete ? { 'aria-describedby': 'password-submit-hint' } : {})}
                className={ACTION}
                disabled={incomplete}
                isLoading={mutation.isPending}
                size="lg"
                type="submit"
              >
                Change password
              </Button>
              {incomplete ? (
                <DisabledHint id="password-submit-hint">
                  Enter both your current and your new password.
                </DisabledHint>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function TwoFactorCard({ user }: { user: SessionUser }) {
  const { setUser } = useAuth();
  const [setupData, setSetupData] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [disarming, setDisarming] = useState(false);

  const begin = useMutation({
    mutationFn: () => api.post<TotpSetup>('/auth/totp/setup'),
    onSuccess: (data) => {
      setSetupData(data);
      setError(null);
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  const confirm = useMutation({
    mutationFn: (token: string) => api.post<{ ok: true }>('/auth/totp/confirm', { token }),
    onSuccess: () => {
      setUser({ ...user, totpEnabled: true });
      setSetupData(null);
      setCode('');
      setError(null);
      toast.create({ title: 'Two-factor authentication is on', type: 'success' });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  const disable = useMutation({
    mutationFn: (token: string) => api.delete<{ ok: true }>('/auth/totp', { body: { token } }),
    onSuccess: () => {
      setUser({ ...user, totpEnabled: false });
      setDisarming(false);
      setCode('');
      setError(null);
      toast.create({ title: 'Two-factor authentication is off', type: 'success' });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Two-factor authentication</CardTitle>
        <CardDescription>
          A six-digit code from an authenticator app, on top of your password. Platter never sends
          codes by email or SMS.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {error ? (
          <p
            className="rounded-sm border border-danger/25 bg-danger-subtle px-3 py-2 text-subhead text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {user.totpEnabled && !disarming ? (
          <>
            <p className="text-subhead text-label-secondary">
              Two-factor authentication is <strong className="font-medium text-label">on</strong>.
              You will be asked for a code every time you sign in.
            </p>
            <Button
              className={cn(ACTION, 'w-fit')}
              onClick={() => {
                setDisarming(true);
                setError(null);
              }}
              size="lg"
              variant="outline"
            >
              Turn it off
            </Button>
          </>
        ) : null}

        {user.totpEnabled && disarming ? (
          <form
            className="flex max-w-md flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              disable.mutate(code);
            }}
          >
            <Field required>
              <FieldLabel>Current code</FieldLabel>
              <Input
                autoFocus
                className={cn(FIELD_HEIGHT, 'font-mono')}
                inputMode="numeric"
                maxLength={6}
                name="disable-totp"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                value={code}
              />
              <FieldHelper>
                Proving you still hold the second factor is what stops a stolen session from
                removing it.
              </FieldHelper>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                {...(code.length === 6 ? {} : { 'aria-describedby': 'totp-off-hint' })}
                className={ACTION}
                disabled={code.length !== 6}
                isLoading={disable.isPending}
                size="lg"
                type="submit"
                variant="destructive"
              >
                Turn off two-factor
              </Button>
              <Button
                className={ACTION}
                onClick={() => {
                  setDisarming(false);
                  setCode('');
                }}
                size="lg"
                variant="ghost"
              >
                Cancel
              </Button>
              {code.length === 6 ? null : (
                <DisabledHint id="totp-off-hint">Enter the six-digit code first.</DisabledHint>
              )}
            </div>
          </form>
        ) : null}

        {!user.totpEnabled && !setupData ? (
          <>
            <p className="text-subhead text-label-secondary">
              Two-factor authentication is <strong className="font-medium text-label">off</strong>.
            </p>
            <Button
              className={cn(ACTION, 'w-fit')}
              isLoading={begin.isPending}
              onClick={() => begin.mutate()}
              size="lg"
            >
              Set it up
            </Button>
          </>
        ) : null}

        {!user.totpEnabled && setupData ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
              <QrCode className="[--qr-code-size:--spacing(40)]" value={setupData.otpauthUrl}>
                <QrCodeFrame />
              </QrCode>

              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <p className="text-subhead text-label-secondary">
                  Scan this with your authenticator app, then enter the code it shows.
                </p>
                <CopyField label="Setup key" showLabel value={setupData.secret} />
                <p className="text-caption text-label-tertiary">
                  Use the key if you cannot scan the square — for example when the app is on the
                  same device.
                </p>
              </div>
            </div>

            <Alert variant="warning">
              <AlertTitle className="font-sans">Save your recovery codes now</AlertTitle>
              <AlertDescription>
                <p>
                  These are the only way back in if you lose the authenticator. They are shown once
                  and are not stored in a form we can read back.
                </p>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-footnote text-label sm:grid-cols-3">
                  {setupData.recoveryCodes.map((recoveryCode) => (
                    <li key={recoveryCode}>{recoveryCode}</li>
                  ))}
                </ul>
                <CopyField
                  label="All recovery codes"
                  display={`${setupData.recoveryCodes.length} codes`}
                  value={setupData.recoveryCodes.join('\n')}
                  variant="inline"
                />
              </AlertDescription>
            </Alert>

            <form
              className="flex max-w-md flex-col gap-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                confirm.mutate(code);
              }}
            >
              <Field required>
                <FieldLabel>Code from your app</FieldLabel>
                <Input
                  className={cn(FIELD_HEIGHT, 'font-mono')}
                  inputMode="numeric"
                  maxLength={6}
                  name="confirm-totp"
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  value={code}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  {...(code.length === 6 ? {} : { 'aria-describedby': 'totp-on-hint' })}
                  className={ACTION}
                  disabled={code.length !== 6}
                  isLoading={confirm.isPending}
                  size="lg"
                  type="submit"
                >
                  Turn on two-factor
                </Button>
                <Button
                  className={ACTION}
                  onClick={() => {
                    setSetupData(null);
                    setCode('');
                  }}
                  size="lg"
                  variant="ghost"
                >
                  Cancel
                </Button>
                {code.length === 6 ? null : (
                  <DisabledHint id="totp-on-hint">Enter the six-digit code first.</DisabledHint>
                )}
              </div>
            </form>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function ApiKeysCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const keys = useQuery({
    queryKey: ['auth', 'keys'] as const,
    queryFn: () => api.get<ApiKey[]>('/auth/keys'),
  });

  const create = useMutation({
    mutationFn: (input: { name: string }) =>
      api.post<ApiKey & { token: string }>('/auth/keys', {
        name: input.name,
        expiresInDays: null,
      }),
    onSuccess: (created) => {
      setIssued({ name: created.name, token: created.token });
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['auth', 'keys'] });
    },
    onError: (error: unknown) =>
      toast.create({
        title: 'Could not create the key',
        description: errorMessage(error),
        type: 'error',
      }),
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api.delete<{ ok: true }>(`/auth/keys/${keyId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'keys'] });
      toast.create({ title: 'Key revoked', type: 'success' });
    },
    onError: (error: unknown) =>
      toast.create({
        title: 'Could not revoke the key',
        description: errorMessage(error),
        type: 'error',
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>API keys</CardTitle>
        <CardDescription>
          Long-lived credentials for scripts, Prometheus and the MCP transport. A key cannot change
          your password or create more keys.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {issued ? (
          <Alert variant="warning">
            <AlertTitle className="font-sans">Copy this token now</AlertTitle>
            <AlertDescription>
              <p>
                This is the only time{' '}
                <strong className="font-medium text-label">{issued.name}</strong> is readable.
                Platter stores a hash, so it cannot show it again.
              </p>
              <CopyField label="API token" value={issued.token} />
              <Button className="w-fit" onClick={() => setIssued(null)} size="sm" variant="outline">
                I have saved it
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ name: name.trim() });
          }}
        >
          <Field className="max-w-xs flex-1">
            <FieldLabel>New key name</FieldLabel>
            <Input
              className={FIELD_HEIGHT}
              maxLength={64}
              name="keyName"
              onChange={(event) => setName(event.target.value)}
              placeholder="Backup script"
              value={name}
            />
          </Field>
          <Button
            {...(name.trim().length === 0 ? { 'aria-describedby': 'key-create-hint' } : {})}
            className={ACTION}
            disabled={name.trim().length === 0}
            isLoading={create.isPending}
            size="lg"
            type="submit"
          >
            Create key
          </Button>
          {name.trim().length === 0 ? (
            <DisabledHint id="key-create-hint">
              Name the key so you can revoke it later.
            </DisabledHint>
          ) : null}
        </form>

        {keys.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 rounded-sm" />
            <Skeleton className="h-12 rounded-sm" />
          </div>
        ) : null}

        {keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} variant="inline" />
        ) : null}

        {keys.isSuccess && keys.data.length === 0 ? (
          <EmptyState
            description="Create one when a script, a scrape job or an agent needs to talk to Platter without a browser."
            size="sm"
            title="No API keys yet"
          />
        ) : null}

        {keys.isSuccess && keys.data.length > 0 ? (
          <ul className="divide-y divide-separator border-t border-separator">
            {keys.data.map((key) => (
              <li className="flex flex-wrap items-center gap-3 py-3" key={key.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-subhead font-medium text-label">{key.name}</p>
                  <p className="mt-0.5 font-mono text-caption text-label-tertiary">
                    {key.prefix}…{' · '}
                    {key.lastUsedAt ? `used ${formatRelativeTime(key.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <Button
                  className={cn(ACTION, 'px-4')}
                  isLoading={revoke.isPending && revoke.variables === key.id}
                  onClick={() => revoke.mutate(key.id)}
                  size="lg"
                  variant="outline"
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

function AppearanceCard() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle className={SECTION_TITLE}>Appearance</CardTitle>
        <CardDescription>
          Light is the canonical theme. The console stays dark either way.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Three fixed-width segments overflowed their own card at 360px and took the whole
            document sideways with them — the only page in the app that scrolled
            horizontally. They now share the row instead of demanding their natural width. */}
        <SegmentGroup
          className="w-full"
          onValueChange={({ value }) => setPreference(value as ThemePreference)}
          value={preference}
        >
          {THEME_CHOICES.map((choice) => {
            const Icon = choice.icon;
            return (
              <SegmentGroupItem
                className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-2 text-subhead sm:px-4"
                key={choice.value}
                value={choice.value}
              >
                <Icon aria-hidden className="relative z-1 size-4" />
                <SegmentGroupItemText>{choice.label}</SegmentGroupItemText>
              </SegmentGroupItem>
            );
          })}
        </SegmentGroup>
        <p aria-live="polite" className="text-caption text-label-tertiary" role="status">
          Currently showing the {resolved} theme.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------

export function ProfilePage() {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <>
      <PageHeader
        description="Your details, how you sign in, and the credentials other tools use."
        title="Account"
      />
      <PageBody>
        <div className="flex flex-col gap-6">
          <ProfileCard user={user} />
          <PasswordCard />
          <TwoFactorCard user={user} />
          <ApiKeysCard />
          <AppearanceCard />
        </div>
      </PageBody>
    </>
  );
}
