import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '@platter/shared';
import { ConsoleView, normaliseLogText } from '../console-view';
import { ConsoleInput, consoleInputBlockedReason } from '../console-input';

/**
 * The console is the one component here where a plausible-looking implementation is still
 * broken: it can render every line and freeze the tab, it can yank the view back down while
 * someone is reading, it can print raw escape codes, and it can steal focus out of the
 * command box. Each of those is a test below, because none of them is visible in a screenshot.
 */

// Ark's ScrollArea (reached through Tooltip's portal machinery) observes intersections, and
// jsdom implements neither observer.
beforeAll(() => {
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds: readonly number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }
});

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

function line(content: string, index = 0, stream: LogLine['stream'] = 'stdout'): LogLine {
  return {
    seq: index,
    stream,
    content,
    timestamp: new Date(Date.UTC(2026, 7, 7, 12, 0, index % 60)).toISOString(),
  };
}

function manyLines(count: number): LogLine[] {
  return Array.from({ length: count }, (_, index) => line(`line number ${index}`, index));
}

/** The scroller carries `role="log"`; jsdom reports zero for every box, so tests set them. */
function measureScroller(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', {
    value: metrics.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(element, 'clientHeight', {
    value: metrics.clientHeight,
    configurable: true,
  });
  Object.defineProperty(element, 'scrollTop', {
    value: metrics.scrollTop,
    writable: true,
    configurable: true,
  });
}

function renderedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-stream]'));
}

// =======================================================================================

describe('normaliseLogText', () => {
  it('strips ANSI colour and cursor sequences rather than printing them', () => {
    expect(normaliseLogText(`${ESC}[32mServer started${ESC}[0m`)).toBe('Server started');
    expect(normaliseLogText(`${ESC}[2J${ESC}[HDone`)).toBe('Done');
  });

  it('strips OSC window-title sequences, terminated either way', () => {
    expect(normaliseLogText(`${ESC}]0;minecraft${BELL}ready`)).toBe('ready');
    expect(normaliseLogText(`${ESC}]0;mc${ESC}\\ready`)).toBe('ready');
  });

  it('strips Minecraft legacy section codes', () => {
    expect(normaliseLogText('§aPlayer §fjoined')).toBe('Player joined');
  });

  it('keeps only the final write of a carriage-return progress line', () => {
    expect(normaliseLogText('Downloading 10%\rDownloading 90%')).toBe('Downloading 90%');
    expect(normaliseLogText('Downloading 90%\r')).toBe('Downloading 90%');
  });

  it('expands tabs so the wrap arithmetic sees real character widths', () => {
    expect(normaliseLogText('a\tb')).toBe('a    b');
  });

  it('removes stray control characters but leaves ordinary text alone', () => {
    expect(normaliseLogText(`hel${String.fromCharCode(0)}lo`)).toBe('hello');
    expect(normaliseLogText('[12:04:11] [Server thread/INFO]: Done (5.2s)')).toBe(
      '[12:04:11] [Server thread/INFO]: Done (5.2s)',
    );
  });
});

// =======================================================================================

describe('ConsoleView', () => {
  it('is a log region and does not render the whole buffer', () => {
    render(<ConsoleView connectionState="open" lines={manyLines(500)} serverName="Survival SMP" />);

    const log = screen.getByRole('log', { name: /Survival SMP/ });
    expect(log).toBeInTheDocument();

    // The cap is what keeps a chatty server from locking the tab. The exact window size is an
    // implementation detail; that it is nowhere near 500 is the contract.
    const rows = renderedRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(150);
  });

  it('reports the real line count even though only a window is drawn', () => {
    render(<ConsoleView connectionState="open" lines={manyLines(500)} serverName="Survival SMP" />);
    expect(screen.getByText('500 lines')).toBeInTheDocument();
  });

  it('never moves focus when lines arrive', () => {
    const { rerender } = render(
      <>
        <input aria-label="somewhere else" />
        <ConsoleView connectionState="open" lines={manyLines(5)} serverName="Survival SMP" />
      </>,
    );

    const outside = screen.getByLabelText('somewhere else');
    outside.focus();
    expect(document.activeElement).toBe(outside);

    rerender(
      <>
        <input aria-label="somewhere else" />
        <ConsoleView connectionState="open" lines={manyLines(40)} serverName="Survival SMP" />
      </>,
    );

    expect(document.activeElement).toBe(outside);
  });

  it('follows the tail by default and says so', () => {
    render(<ConsoleView connectionState="open" lines={manyLines(20)} serverName="Survival SMP" />);
    expect(screen.getByText('Following the latest output')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
  });

  it('stops following once the reader scrolls up, and counts what arrives meanwhile', () => {
    const { rerender } = render(
      <ConsoleView connectionState="open" lines={manyLines(20)} serverName="Survival SMP" />,
    );

    const log = screen.getByRole('log', { name: /Survival SMP/ });
    measureScroller(log, { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(log);

    expect(screen.getByText('Paused while you scroll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeInTheDocument();
    // Announcements are muted while paused, so scrolling does not re-read the buffer.
    expect(log).toHaveAttribute('aria-live', 'off');

    rerender(<ConsoleView connectionState="open" lines={manyLines(23)} serverName="Survival SMP" />);
    expect(screen.getByRole('button', { name: /3 new lines/ })).toBeInTheDocument();
  });

  it('returns to following when the jump control is pressed', async () => {
    const user = userEvent.setup();
    render(<ConsoleView connectionState="open" lines={manyLines(20)} serverName="Survival SMP" />);

    const log = screen.getByRole('log', { name: /Survival SMP/ });
    measureScroller(log, { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(log);

    await user.click(screen.getByRole('button', { name: /Jump to latest/ }));

    expect(screen.getByText('Following the latest output')).toBeInTheDocument();
    expect(log.scrollTop).toBe(2000);
  });

  it('filters the buffer and reports how much matched', async () => {
    const user = userEvent.setup();
    render(
      <ConsoleView
        connectionState="open"
        lines={[
          line('Done (5.2s)! For help, type "help"', 0),
          line('Player Ada joined the game', 1),
          line('Player Grace joined the game', 2),
        ]}
        serverName="Survival SMP"
      />,
    );

    await user.type(screen.getByLabelText('Filter console lines'), 'joined');

    expect(screen.getByText('2 of 3 lines match')).toBeInTheDocument();
    const log = screen.getByRole('log', { name: /Survival SMP/ });
    expect(within(log).queryByText(/For help/)).not.toBeInTheDocument();
    expect(renderedRows()).toHaveLength(2);
  });

  it('says so plainly when nothing matches, rather than showing an empty pane', async () => {
    const user = userEvent.setup();
    render(<ConsoleView connectionState="open" lines={manyLines(5)} serverName="Survival SMP" />);

    await user.type(screen.getByLabelText('Filter console lines'), 'zzzz');
    expect(screen.getByText(/No line matches/)).toBeInTheDocument();
  });

  it('distinguishes stderr and system lines by more than colour', () => {
    render(
      <ConsoleView
        connectionState="open"
        lines={[
          line('normal output', 0, 'stdout'),
          line('java.lang.OutOfMemoryError', 1, 'stderr'),
          line('Container started', 2, 'system'),
        ]}
        serverName="Survival SMP"
      />,
    );

    const rows = renderedRows();
    expect(rows.map((row) => row.dataset.stream)).toEqual(['stdout', 'stderr', 'system']);
    expect(screen.getByText('Error output:')).toBeInTheDocument();
    expect(screen.getByText('Platter:')).toBeInTheDocument();
  });

  it('explains an empty console instead of showing a blank box', () => {
    render(<ConsoleView connectionState="closed" lines={[]} serverName="Survival SMP" />);
    expect(screen.getByText('The console is not connected.')).toBeInTheDocument();
  });

  it('offers clearing only when the screen can act on it', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <ConsoleView
        connectionState="open"
        lines={manyLines(3)}
        onClear={onClear}
        serverName="Survival SMP"
      />,
    );
    expect(screen.getByRole('button', { name: 'Clear the console view' })).toBeInTheDocument();

    rerender(<ConsoleView connectionState="open" lines={manyLines(3)} serverName="Survival SMP" />);
    expect(screen.queryByRole('button', { name: 'Clear the console view' })).not.toBeInTheDocument();
  });
});

// =======================================================================================

describe('consoleInputBlockedReason', () => {
  it('is open only on a live socket with write permission and a running server', () => {
    expect(consoleInputBlockedReason(true, 'open', 'running')).toBeNull();
  });

  it('names the connection as the problem before the permission', () => {
    expect(consoleInputBlockedReason(false, 'reconnecting', 'running')).toMatch(/reconnecting/i);
  });

  it('names the missing permission rather than saying "unavailable"', () => {
    expect(consoleInputBlockedReason(false, 'open', 'running')).toMatch(/console\.write/);
  });

  it('says what the server is doing when it is not running', () => {
    expect(consoleInputBlockedReason(true, 'open', 'offline')).toMatch(/offline/i);
    expect(consoleInputBlockedReason(true, 'open', 'installing')).toMatch(/installing/i);
    expect(consoleInputBlockedReason(true, 'open', 'starting')).toMatch(/booting/i);
  });
});

describe('ConsoleInput', () => {
  function setup(overrides: Partial<React.ComponentProps<typeof ConsoleInput>> = {}) {
    const onSubmit = vi.fn(() => true);
    render(
      <ConsoleInput
        canWrite
        connectionState="open"
        onSubmit={onSubmit}
        serverId={`s-${Math.random().toString(36).slice(2)}`}
        serverName="Survival SMP"
        serverStatus="running"
        {...overrides}
      />,
    );
    return { onSubmit };
  }

  it('sends a command and clears the field', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const field = screen.getByLabelText('Send a command to Survival SMP');
    await user.type(field, 'list{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('list');
    expect(field).toHaveValue('');
  });

  it('walks back through history with the up arrow and forward again with down', async () => {
    const user = userEvent.setup();
    setup();

    const field = screen.getByLabelText('Send a command to Survival SMP');
    await user.type(field, 'say first{Enter}');
    await user.type(field, 'say second{Enter}');

    await user.type(field, '{ArrowUp}');
    expect(field).toHaveValue('say second');

    await user.type(field, '{ArrowUp}');
    expect(field).toHaveValue('say first');

    await user.type(field, '{ArrowDown}');
    expect(field).toHaveValue('say second');

    await user.type(field, '{ArrowDown}');
    expect(field).toHaveValue('');
  });

  it('is disabled with a visible, referenced reason when the server is not running', () => {
    setup({ serverStatus: 'offline' });

    const field = screen.getByLabelText('Send a command to Survival SMP');
    expect(field).toBeDisabled();

    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy ?? '');
    expect(hint?.textContent).toMatch(/offline/i);
  });

  it('surfaces a refused command rather than silently swallowing it', async () => {
    const user = userEvent.setup();
    setup({ onSubmit: vi.fn(() => false) });

    await user.type(screen.getByLabelText('Send a command to Survival SMP'), 'stop{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(/not sent/i);
  });
});
