/**
 * Redaction for text that is about to be written somewhere durable and widely readable.
 *
 * The audit log is the case that matters. `routes/servers.ts` already refuses to record a
 * server update's *values* — "a variable can hold an RCON password, and the audit log is
 * readable by every admin" — but console input was recorded verbatim, and the console is
 * exactly where an operator types `rcon-password …`, `luckperms user … setpassword …` or a
 * plugin's own credential. An `audit.read`-scoped key handed to a log shipper then reads
 * all of it.
 */

/**
 * Words after which the next token is a credential, not a subcommand.
 *
 * Deliberately narrow. `login` and `auth` are *not* here: `login steve` would then hide the
 * username, and a log that redacts ordinary arguments teaches operators to ignore it.
 */
const SECRET_VERB =
  /^(?:.*[-_])?(?:password|passwd|passwrd|secret|token|apikey|setpassword|passwordset)$/i;

/** Flags whose value is a credential: `--password hunter2`, `--api-key=…`. */
const SECRET_FLAG = /^--?(?:[a-z0-9-]*[-_])?(?:password|passwd|secret|token|key|auth)(?:=(.*))?$/i;

/** A `KEY=value` argument whose key reads as a secret. */
const SECRET_ASSIGNMENT =
  /^([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_.-]*)=(.*)$/i;

export const REDACTED = '[redacted]';

/** Longer than any real console command an operator types; beyond this it is a paste. */
const MAX_RECORDED_LENGTH = 512;

/**
 * A console command, safe to store.
 *
 * Structure is preserved — an operator reading the audit log needs to know that someone ran
 * `op` and on whom — and only the tokens that follow a credential-shaped word or flag are
 * replaced. Nothing is dropped silently: a redacted token is visibly `[redacted]`, so the
 * log says a secret was passed rather than pretending none was.
 */
export function redactCommand(command: string): string {
  const clipped =
    command.length > MAX_RECORDED_LENGTH ? `${command.slice(0, MAX_RECORDED_LENGTH)}…` : command;

  // Split on runs of whitespace, keeping the separators so the rebuilt string still reads
  // the way it was typed.
  const parts = clipped.split(/(\s+)/);
  let redactNext = false;

  const out = parts.map((part) => {
    if (part.length === 0 || /^\s+$/.test(part)) return part;

    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }

    const assignment = SECRET_ASSIGNMENT.exec(part);
    if (assignment) return `${assignment[1] ?? ''}=${REDACTED}`;

    const flag = SECRET_FLAG.exec(part);
    if (flag) {
      // `--password=x` carries its value; `--password x` takes the next token.
      if (flag[1] !== undefined) return `${part.slice(0, part.indexOf('='))}=${REDACTED}`;
      redactNext = true;
      return part;
    }

    if (SECRET_VERB.test(part)) redactNext = true;
    return part;
  });

  return out.join('');
}
