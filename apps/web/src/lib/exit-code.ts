/**
 * What a container exit code means, in words, and what to do about it.
 *
 * A crash banner that says "exit code 137" and stops is a dead end for the person it is
 * written for: the number is only meaningful to someone who already knows that Docker reports
 * a signal death as `128 + signal`, and that signal 9 on a container with a memory limit is
 * almost always the kernel's OOM killer rather than anybody's decision.
 *
 * The API already reaches this conclusion — `services/lifecycle.ts` writes "ran out of memory
 * and was killed" into the console when Docker reports `OOMKilled` — but that flag is not on
 * the server payload, so the browser has to infer it from the code. 137 on a container that
 * Platter did not stop is the OOM case often enough to lead with it, and the wording says
 * "nearly always" rather than asserting a certainty this side cannot check.
 */

export interface ExitCodeExplanation {
  /** What happened, in one sentence. */
  summary: string;
  /** The next thing to try, or null when the console is the only honest advice. */
  fix: string | null;
  /** Whether running out of memory is the likely cause, which changes what to offer. */
  outOfMemory: boolean;
}

const SIGNAL_NAMES: Record<number, string> = {
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
};

export function describeExitCode(code: number | null): ExitCodeExplanation | null {
  if (code === null) return null;

  switch (code) {
    case 0:
      return {
        summary: 'The process ended cleanly, so something inside the server asked it to shut down.',
        fix: 'A stop command in the console, a scheduled restart, or a plugin shutting the world down all look like this.',
        outOfMemory: false,
      };
    case 1:
      return {
        summary: 'The server stopped with an error of its own.',
        fix: 'A mod or plugin that will not load, or a line the config file could not parse, are the usual causes.',
        outOfMemory: false,
      };
    case 127:
      return {
        summary: 'The start command was not found inside the container image.',
        fix: 'Check the server type and version in Settings — a jar the image cannot fetch reads like this.',
        outOfMemory: false,
      };
    case 137:
      return {
        summary:
          'The process was killed outright, which on a container with a memory limit nearly always means it ran out of memory.',
        fix: 'Give it more memory, then start it again. Minecraft with mods routinely needs 4 GB or more.',
        outOfMemory: true,
      };
    case 143:
      return {
        summary: 'Something asked the process to stop and it did.',
        fix: 'If you did not stop it, the node itself was probably restarting or shutting down.',
        outOfMemory: false,
      };
    default:
      break;
  }

  if (code > 128 && code < 160) {
    const signal = code - 128;
    const name = SIGNAL_NAMES[signal];
    return {
      summary: `The process was stopped by signal ${signal}${name ? ` (${name})` : ''} rather than exiting on its own.`,
      fix: null,
      outOfMemory: false,
    };
  }

  return {
    summary: `The server exited with code ${code}.`,
    fix: null,
    outOfMemory: false,
  };
}
