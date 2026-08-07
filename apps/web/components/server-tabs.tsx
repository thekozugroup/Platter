'use client';

import { Tab, TabList } from '@astryxdesign/core/TabList';
import { usePathname, useRouter } from 'next/navigation';

const TABS = [
  { value: '', label: 'Overview' },
  { value: 'console', label: 'Console' },
  { value: 'mods', label: 'Mods' },
  { value: 'backups', label: 'Backups' },
  { value: 'activity', label: 'Activity' },
  { value: 'settings', label: 'Settings' },
] as const;

/**
 * Tabs are routes, not local state.
 *
 * A link to a server's console is then a link to its console — shareable, bookmarkable, correct
 * after a refresh. Each tab also fetches only its own data on the server, so opening Overview
 * does not pay for the backup list.
 *
 * `href` makes each tab a real anchor (middle-click, copy link, browser history); `onChange`
 * keeps keyboard arrow-key navigation working. Both land in the same place.
 */
export function ServerTabs({ serverId }: { serverId: string }) {
  const pathname = usePathname();
  const router = useRouter();

  const base = `/servers/${serverId}`;
  const segment = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, '') : '';
  const active = TABS.some((tab) => tab.value === segment) ? segment : '';

  const hrefFor = (value: string) => (value === '' ? base : `${base}/${value}`);

  return (
    <TabList value={active} onChange={(value: string) => router.push(hrefFor(value))}>
      {TABS.map((tab) => (
        <Tab
          key={tab.value || 'overview'}
          value={tab.value}
          label={tab.label}
          href={hrefFor(tab.value)}
        />
      ))}
    </TabList>
  );
}
