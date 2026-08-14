import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { LIMITS, slugify } from '@platter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from '@/components/ui/password-input';
import { Progress } from '@/components/ui/progress';
import { AppSplash } from '@/components/layout/app-shell';
import { ErrorState } from '@/components/common/error-state';
import { PlatterMark } from '@/components/common/platter-mark';
import { ApiError, NetworkError, errorMessage } from '@/lib/api-client.js';
import { useAuth, useSystemInfo } from '@/lib/auth.js';
import { cn } from '@/lib/utils';

/**
 * First run.
 *
 * The account made here owns the installation, and there is no "forgot password" behind it —
 * no mail server is configured on a fresh self-hosted box. So the screen says that plainly
 * and pushes on length rather than composition rules, which is also what the API enforces.
 */

const FIELD_HEIGHT = 'h-11';

interface Strength {
  /** 0–4. */
  score: number;
  label: string;
  advice: string;
}

/**
 * Length first, variety second. `P@ssw0rd!` satisfies every composition rule ever written
 * and is on every cracking list; four unrelated words are not.
 */
function scorePassword(value: string): Strength {
  if (value.length === 0) {
    return { score: 0, label: 'Empty', advice: `At least ${LIMITS.passwordMin} characters.` };
  }
  if (value.length < LIMITS.passwordMin) {
    return {
      score: 0,
      label: 'Too short',
      advice: `${LIMITS.passwordMin - value.length} more character${
        LIMITS.passwordMin - value.length === 1 ? '' : 's'
      } to go.`,
    };
  }

  const distinct = new Set(value).size;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  const repetitive = /^(.)\1+$/.test(value) || /^(?:0123|1234|abcd|qwer)/i.test(value);

  let score = 1;
  if (value.length >= 16) score += 1;
  if (value.length >= 24) score += 1;
  if (distinct >= 10 && classes >= 2) score += 1;
  if (repetitive) score = 1;
  score = Math.min(score, 4);

  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Very strong'];
  const advice =
    score >= 3
      ? 'Good. Store it in a password manager — there is no reset email on a fresh install.'
      : 'Longer beats more symbols. Four unrelated words works well.';

  return { score, label: labels[score] ?? 'Weak', advice };
}

const METER_TONE = [
  'bg-neutral-status',
  'bg-danger-dot',
  'bg-warning-dot',
  'bg-success-dot',
  'bg-success-dot',
];

export function SetupPage() {
  const { register, status } = useAuth();
  const systemInfo = useSystemInfo();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const strength = useMemo(() => scorePassword(password), [password]);
  const effectiveUsername = usernameEdited ? username : slugify(displayName, '');

  if (status === 'authenticated') return <Navigate replace to="/" />;
  if (systemInfo.isPending) return <AppSplash label="Checking this installation" />;
  if (systemInfo.isError) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <ErrorState error={systemInfo.error} onRetry={() => void systemInfo.refetch()} />
      </div>
    );
  }
  if (!systemInfo.data.needsSetup) return <Navigate replace to="/login" />;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await register({
        displayName: displayName.trim(),
        username: effectiveUsername,
        email: email.trim(),
        password,
      });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError("Can't reach Platter. Check the API is running, then try again.");
      } else if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
      } else {
        setFormError(errorMessage(error));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <p className="flex items-center gap-2 font-heading text-headline font-medium tracking-title text-label">
            <PlatterMark className="size-5" />
            Platter
          </p>
          <h1 className="mt-6 text-title-1 text-label">Create the owner account</h1>
          <p className="mt-3 text-body text-label-secondary">
            Nobody has signed in to this installation yet. The first account owns it: it can create
            servers, add nodes, and promote everyone else.
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

              <Field invalid={Boolean(fieldErrors.displayName)} required>
                <FieldLabel>Your name</FieldLabel>
                <Input
                  autoComplete="name"
                  autoFocus
                  className={FIELD_HEIGHT}
                  maxLength={64}
                  name="displayName"
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
                <FieldHelper>Shown next to anything you do, in the audit log included.</FieldHelper>
                <FieldError>{fieldErrors.displayName}</FieldError>
              </Field>

              <Field invalid={Boolean(fieldErrors.username)} required>
                <FieldLabel>Username</FieldLabel>
                <Input
                  autoComplete="username"
                  className={cn(FIELD_HEIGHT, 'font-mono')}
                  maxLength={32}
                  name="username"
                  onChange={(event) => {
                    setUsernameEdited(true);
                    setUsername(event.target.value.toLowerCase());
                  }}
                  value={effectiveUsername}
                />
                <FieldHelper>
                  Lowercase letters, numbers, dashes and underscores. Used in URLs and the API.
                </FieldHelper>
                <FieldError>{fieldErrors.username}</FieldError>
              </Field>

              <Field invalid={Boolean(fieldErrors.email)} required>
                <FieldLabel>Email</FieldLabel>
                <Input
                  autoComplete="email"
                  className={FIELD_HEIGHT}
                  inputMode="email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                />
                <FieldHelper>Used to sign in. Platter does not send mail.</FieldHelper>
                <FieldError>{fieldErrors.email}</FieldError>
              </Field>

              <Field invalid={Boolean(fieldErrors.password)} required>
                <FieldLabel>Password</FieldLabel>
                <PasswordInput size="lg">
                  <PasswordInputGroup className={FIELD_HEIGHT}>
                    <PasswordInputInput
                      autoComplete="new-password"
                      name="password"
                      onChange={(event) => setPassword(event.target.value)}
                      value={password}
                    />
                    <PasswordInputTrigger aria-label="Toggle password visibility" />
                  </PasswordInputGroup>
                </PasswordInput>

                {/*
                  The bar is decoration; the sentence under it is the real feedback, so it
                  lives in a polite live region and never depends on the colour of the fill.
                */}
                <Progress
                  aria-hidden
                  className="mt-1 [&_[data-slot=progress-track]]:h-1"
                  value={strength.score * 25}
                />
                <div className="mt-1 flex items-baseline gap-2 text-caption">
                  <span
                    aria-hidden
                    className={cn(
                      'inline-block size-2 rounded-full',
                      METER_TONE[strength.score] ?? 'bg-neutral-status',
                    )}
                  />
                  <span aria-live="polite" className="text-label-secondary" role="status">
                    <strong className="font-medium text-label">{strength.label}.</strong>{' '}
                    {strength.advice}
                  </span>
                </div>

                <FieldError>{fieldErrors.password}</FieldError>
              </Field>

              <Button
                className="mt-2 h-11 w-full rounded-button text-subhead font-medium"
                isLoading={submitting}
                size="lg"
                type="submit"
              >
                Create account and sign in
              </Button>
            </FieldGroup>
          </form>
        </div>
      </div>

      <aside className="hidden flex-col justify-between border-s border-separator bg-surface-warm px-10 py-12 lg:flex">
        <div>
          <h2 className="text-title-2 text-label">What happens next</h2>
          <ol className="mt-6 grid gap-5 text-subhead">
            <li>
              <span className="font-medium text-label">1. You sign in</span>
              <p className="mt-1 text-label-secondary">
                This account becomes the owner. Everyone added later starts as a member.
              </p>
            </li>
            <li>
              <span className="font-medium text-label">2. Pick a game</span>
              <p className="mt-1 text-label-secondary">
                Blueprints ship with Platter — Minecraft first, others alongside it.
              </p>
            </li>
            <li>
              <span className="font-medium text-label">3. Press play</span>
              <p className="mt-1 text-label-secondary">
                Platter pulls the image, runs the install script and streams the console.
              </p>
            </li>
          </ol>
        </div>

        <p className="font-mono text-caption text-label-quaternary">
          Platter v{systemInfo.data.version}
        </p>
      </aside>
    </div>
  );
}
