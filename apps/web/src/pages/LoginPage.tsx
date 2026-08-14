import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import { PlatterMark } from '@/components/common/platter-mark';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from '@/components/ui/password-input';
import { ApiError, NetworkError, errorMessage } from '@/lib/api-client.js';
import { useAuth, useSystemInfo } from '@/lib/auth.js';
import { cn } from '@/lib/utils';

/**
 * Sign in.
 *
 * Two rules shape the error handling. Bad credentials always get the same sentence whether
 * the email exists or not — a distinct "no such user" turns the form into an account
 * enumeration oracle. And the second-factor field only appears once the API has asked for
 * it, because showing it up front tells anyone with a list of emails which accounts have 2FA
 * turned off.
 */

const FIELD_HEIGHT = 'h-11';

export function LoginPage() {
  const { login } = useAuth();
  const systemInfo = useSystemInfo();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // The pair was rejected together, so both fields are marked but neither is blamed — which
  // one was wrong is exactly what this form must not reveal.
  const [credentialsRejected, setCredentialsRejected] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const totpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  // A fresh install has no accounts at all; the sign-in form would be a dead end.
  if (systemInfo.data?.needsSetup) return <Navigate replace to="/setup" />;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    setFieldErrors({});
    setCredentialsRejected(false);

    try {
      await login({
        email: email.trim(),
        password,
        ...(needsTotp && totp ? { totp } : {}),
      });
      // Navigation is the guard's job: once `status` flips, `AnonymousOnly` moves us on.
    } catch (error) {
      handleFailure(error);
    } finally {
      setSubmitting(false);
    }
  }

  function handleFailure(error: unknown) {
    if (error instanceof NetworkError) {
      setFormError("Can't reach Platter. Check the API is running, then try again.");
      return;
    }

    if (!(error instanceof ApiError)) {
      setFormError(errorMessage(error));
      return;
    }

    const fields = error.fieldErrors;

    if (error.code === 'invalid_credentials') {
      if (fields.totp) {
        if (needsTotp) {
          // We already showed the field, so this is a wrong code, not a first prompt.
          setFieldErrors({ totp: fields.totp });
        } else {
          setNeedsTotp(true);
          setNotice('This account uses two-factor authentication. Enter the current code.');
        }
        return;
      }
      // Deliberately identical for an unknown email and a wrong password.
      setCredentialsRejected(true);
      setFormError('That email and password don’t match an account.');
      return;
    }

    if (error.code === 'rate_limited') {
      setFormError('Too many sign-in attempts. Wait about a minute, then try again.');
      return;
    }

    if (error.code === 'validation_failed') {
      setFieldErrors(fields);
      setFormError('Check the highlighted fields.');
      return;
    }

    // Suspended accounts and everything else: the API's own sentence is the honest one.
    setFormError(error.message);
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <p className="flex items-center gap-2 font-heading text-headline font-medium tracking-title text-label">
            <PlatterMark className="size-5" />
            Platter
          </p>
          <h1 className="mt-6 text-title-1 text-label">Sign in</h1>
          <p className="mt-3 text-body text-label-secondary">
            Your servers, your machine. Sign in to pick up where you left off.
          </p>

          <form className="mt-8" noValidate onSubmit={(event) => void handleSubmit(event)}>
            <FieldGroup>
              {formError ? (
                <p
                  className="rounded-sm border border-danger/25 bg-danger-subtle px-3 py-2 text-subhead text-danger"
                  role="alert"
                >
                  {formError}
                </p>
              ) : null}

              {notice ? (
                <p
                  aria-live="polite"
                  className="rounded-sm border border-separator-strong bg-bg-sunken px-3 py-2 text-subhead text-label-secondary"
                  role="status"
                >
                  {notice}
                </p>
              ) : null}

              <Field invalid={credentialsRejected || Boolean(fieldErrors.email)} required>
                <FieldLabel>Email</FieldLabel>
                <Input
                  autoComplete="username"
                  autoFocus
                  className={FIELD_HEIGHT}
                  inputMode="email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                />
                <FieldError>{fieldErrors.email}</FieldError>
              </Field>

              <Field invalid={credentialsRejected || Boolean(fieldErrors.password)} required>
                <FieldLabel>Password</FieldLabel>
                <PasswordInput size="lg">
                  <PasswordInputGroup className={FIELD_HEIGHT}>
                    <PasswordInputInput
                      autoComplete="current-password"
                      name="password"
                      onChange={(event) => setPassword(event.target.value)}
                      value={password}
                    />
                    <PasswordInputTrigger aria-label="Toggle password visibility" />
                  </PasswordInputGroup>
                </PasswordInput>
                <FieldError>{fieldErrors.password}</FieldError>
              </Field>

              {needsTotp ? (
                <Field invalid={Boolean(fieldErrors.totp)} required>
                  <FieldLabel>Authentication code</FieldLabel>
                  <Input
                    autoComplete="one-time-code"
                    className={cn(FIELD_HEIGHT, 'font-mono')}
                    inputMode="numeric"
                    maxLength={6}
                    name="totp"
                    onChange={(event) => setTotp(event.target.value.replace(/\D/g, ''))}
                    ref={totpRef}
                    value={totp}
                  />
                  <FieldHelper>Six digits from your authenticator app.</FieldHelper>
                  <FieldError>{fieldErrors.totp}</FieldError>
                </Field>
              ) : null}

              <Button
                className="mt-2 h-11 w-full rounded-button text-subhead font-medium"
                isLoading={submitting}
                size="lg"
                type="submit"
              >
                Sign in
              </Button>
            </FieldGroup>
          </form>

          {/* Only once the second factor is actually being asked for. On a first visit — or an
              install where nobody has ever turned 2FA on — it is advice about a problem the
              reader does not have, in the most prominent empty space on the screen. */}
          {needsTotp ? (
            <p className="mt-8 text-caption text-label-tertiary">
              Lost your authenticator? Use a recovery code from when you turned two-factor on — an
              administrator can reset it for you if those are gone too.
            </p>
          ) : null}
        </div>
      </div>

      {/*
        Decorative panel, desktop only. It carries the product's voice rather than an
        illustration: this is the first screen anyone sees, and it should say what Platter is.
      */}
      <aside className="hidden flex-col justify-between border-s border-separator bg-surface-warm px-10 py-12 lg:flex">
        <div>
          <h2 className="text-title-2 text-label">Game servers, plainly</h2>
          <p className="mt-4 max-w-prose text-body text-label-secondary">
            Pick a game. Pick a node. Press play.
          </p>
        </div>

        <dl className="grid gap-6 text-subhead">
          <div>
            <dt className="font-medium text-label">Your Docker, your world files</dt>
            <dd className="mt-1 text-label-secondary">
              Every server is a container on a node you own. Nothing leaves the machine.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-label">A real console, not a log viewer</dt>
            <dd className="mt-1 text-label-secondary">
              Stream stdout live and send commands straight to the process.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-label">Agent-controllable</dt>
            <dd className="mt-1 text-label-secondary">
              The same API drives an MCP server, so an assistant can help — with your approval.
            </dd>
          </div>
        </dl>

        {systemInfo.data ? (
          <p className="font-mono text-caption text-label-quaternary">
            Platter v{systemInfo.data.version}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
