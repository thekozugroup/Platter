import fs from 'node:fs';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LogLine } from '@platter/shared';
import { ConsoleView } from '../console-view';

const ROW = 24;

function line(content: string, index = 0): LogLine {
  return {
    seq: index,
    stream: 'stdout',
    content,
    timestamp: new Date(Date.UTC(2026, 7, 7, 12, 0, index % 60)).toISOString(),
  };
}
function manyLines(count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => line(`line number ${i}`, i));
}
function rows(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-stream]')).map(
    (el) => el.textContent ?? '',
  );
}

const out: string[] = [];
function rec(...a: unknown[]) { out.push(a.map(String).join(' ')); }

describe('probe: virtual window vs programmatic autoscroll', () => {
  it('shows which rows are in the DOM right after a flush', () => {
    const state = { scrollHeight: 100 * ROW, clientHeight: 400, scrollTop: 0 };
    const { rerender } = render(
      <ConsoleView connectionState="open" lines={manyLines(100)} serverName="SMP" />,
    );
    const log = screen.getByRole('log', { name: /SMP/ });
    Object.defineProperty(log, 'scrollHeight', { get: () => state.scrollHeight, configurable: true });
    Object.defineProperty(log, 'clientHeight', { get: () => state.clientHeight, configurable: true });
    Object.defineProperty(log, 'scrollTop', {
      get: () => state.scrollTop,
      set: (v: number) => {
        state.scrollTop = Math.min(v, state.scrollHeight - state.clientHeight);
      },
      configurable: true,
    });

    // Reader is at the tail; a real scroll event tells the component so.
    state.scrollTop = state.scrollHeight - state.clientHeight; // 2000
    fireEvent.scroll(log);
    expect(screen.getByText('Following the latest output')).toBeInTheDocument();
    const before = rows();
    rec('BEFORE flush  scrollTop=', state.scrollTop, 'rows:', before[0], '..', before[before.length - 1], `(n=${before.length})`);

    // A 150ms flush lands 40 new lines. Content grows first, then the layout effect scrolls.
    state.scrollHeight = 140 * ROW;
    rerender(<ConsoleView connectionState="open" lines={manyLines(140)} serverName="SMP" />);

    const after = rows();
    rec('AFTER flush   scrollTop=', state.scrollTop, '(max', state.scrollHeight - state.clientHeight, ') rows:', after[0], '..', after[after.length - 1], `(n=${after.length})`);
    const firstVisibleRow = Math.floor(state.scrollTop / ROW);
    const lastVisibleRow = Math.ceil((state.scrollTop + state.clientHeight) / ROW);
    rec('viewport covers rows', firstVisibleRow, '..', lastVisibleRow, '-> needs "line number', firstVisibleRow, '" .. "line number', lastVisibleRow, '"');
    rec('DOM contains line 130?', after.some((t) => t.includes('line number 130')));
    rec('DOM contains line 139?', after.some((t) => t.includes('line number 139')));

    // Now the async scroll event finally arrives.
    fireEvent.scroll(log);
    const settled = rows();
    rec('AFTER scroll event rows:', settled[0], '..', settled[settled.length - 1], `(n=${settled.length})`);
    rec('DOM contains line 139 now?', settled.some((t) => t.includes('line number 139')));
    fs.writeFileSync('/tmp/claude-0/probe.txt', out.join('\n'));
  });
});
