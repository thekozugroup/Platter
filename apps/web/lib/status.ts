import type { ServerStatus } from '@platter/shared';

/**
 * How a server's status is presented.
 *
 * Kept in one place because status appears in five different components and the moment two of
 * them disagree — the sidebar dot green while the header badge says "starting" — the whole UI
 * stops feeling trustworthy.
 *
 * The wording is chosen to answer the question the user actually has, which is "can my friends
 * join right now". "Starting" and "Installing" both mean no; they are separate because the
 * expected wait is wildly different.
 */

export type StatusVariant = 'success' | 'warning' | 'error' | 'accent' | 'neutral';

export interface StatusPresentation {
  label: string;
  variant: StatusVariant;
  /** Pulses for states that are actively changing, so movement means something. */
  pulsing: boolean;
  /** Shown on hover; explains what the state means without needing docs. */
  tooltip: string;
}

const PRESENTATION: Record<ServerStatus, StatusPresentation> = {
  creating: {
    label: 'Creating',
    variant: 'accent',
    pulsing: true,
    tooltip: 'Setting up the server. This takes a few seconds.',
  },
  installing: {
    label: 'Installing',
    variant: 'accent',
    pulsing: true,
    tooltip: 'Downloading the server and its mods. Can take several minutes the first time.',
  },
  starting: {
    label: 'Starting',
    variant: 'accent',
    pulsing: true,
    tooltip: 'The server is booting and generating the world. Not accepting players yet.',
  },
  running: {
    label: 'Running',
    variant: 'success',
    pulsing: false,
    tooltip: 'Healthy and accepting players.',
  },
  stopping: {
    label: 'Stopping',
    variant: 'warning',
    pulsing: true,
    tooltip: 'Saving the world and shutting down.',
  },
  stopped: {
    label: 'Stopped',
    variant: 'neutral',
    pulsing: false,
    tooltip: 'Not running. Your world is safe on disk.',
  },
  crashed: {
    label: 'Crashed',
    variant: 'error',
    pulsing: false,
    tooltip: 'The server exited unexpectedly. Open Console to see why.',
  },
  unhealthy: {
    label: 'Unhealthy',
    variant: 'warning',
    pulsing: true,
    tooltip: 'Running but not responding. It may be hung or out of memory.',
  },
  deleting: {
    label: 'Deleting',
    variant: 'error',
    pulsing: true,
    tooltip: 'Removing this server.',
  },
  error: {
    label: 'Error',
    variant: 'error',
    pulsing: false,
    tooltip: 'Platter could not reach a known state. See the activity log.',
  },
};

export function presentStatus(status: ServerStatus): StatusPresentation {
  return PRESENTATION[status];
}

/** Can the user connect right now? Drives whether the address is shown as copyable. */
export function isJoinable(status: ServerStatus): boolean {
  return status === 'running';
}

/** Which lifecycle buttons make sense. */
export function availableActions(status: ServerStatus): {
  start: boolean;
  stop: boolean;
  restart: boolean;
} {
  switch (status) {
    case 'running':
    case 'unhealthy':
      return { start: false, stop: true, restart: true };
    case 'stopped':
    case 'crashed':
    case 'error':
      return { start: true, stop: false, restart: false };
    default:
      return { start: false, stop: false, restart: false };
  }
}
