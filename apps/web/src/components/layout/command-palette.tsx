import { Combobox as ArkCombobox, createListCollection } from '@ark-ui/react/combobox';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { Search } from 'pixelarticons/react/Search.js';
import { GameIcon } from '@/components/common/game-icon';
import { StatusPill } from '@/components/common/status-pill';
import { ADMIN_NAV, PRIMARY_NAV, useSidebarServers } from '@/components/layout/sidebar';
import {
  Command,
  CommandContent,
  CommandDialog,
  CommandDialogContent,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ComboboxControl } from '@/components/ui/combobox';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useAuth } from '@/lib/auth.js';

/**
 * ⌘K over everything.
 *
 * For someone running ten servers this is the shortest path to any of them — shorter than
 * reading the sidebar. It is a real combobox (Ark's, through Shark's Command), so the
 * listbox/option ARIA and the arrow-key handling are the ones assistive tech expects rather
 * than a div that happens to respond to keys.
 */

interface PaletteEntry {
  id: string;
  label: string;
  /** Secondary line — an address, or which section a page lives in. */
  hint?: string;
  /** Extra words that should match, never displayed. */
  keywords: string;
  group: 'servers' | 'pages';
  to: string;
  render: () => React.ReactNode;
}

export interface CommandPaletteContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** `⌘K` on Apple keyboards, `Ctrl K` everywhere else. */
  shortcutHint: string;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { status } = useAuth();

  const shortcutHint = useMemo(() => (isApplePlatform() ? '⌘K' : 'Ctrl K'), []);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setIsOpen((current) => !current);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status]);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      isOpen,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen((current) => !current),
      shortcutHint,
    }),
    [isOpen, shortcutHint],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {status === 'authenticated' ? <CommandPalette /> : null}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  }
  return context;
}

function matches(entry: PaletteEntry, query: string): boolean {
  if (query.trim().length === 0) return true;
  const haystack = `${entry.label} ${entry.hint ?? ''} ${entry.keywords}`.toLowerCase();
  // Every whitespace-separated term has to appear, so "surv con" finds Survival → console.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function CommandPalette() {
  const { isOpen, close } = useCommandPalette();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const { data } = useSidebarServers();
  const [query, setQuery] = useState('');

  const entries = useMemo<PaletteEntry[]>(() => {
    const servers: PaletteEntry[] = (data?.data ?? []).map((server) => ({
      id: `server:${server.id}`,
      label: server.name,
      hint: server.primaryAddress ?? undefined,
      keywords: `${server.blueprintKey} ${server.status} server`,
      group: 'servers',
      to: `/servers/${server.id}`,
      render: () => (
        <>
          <GameIcon blueprintKey={server.blueprintKey} name={server.name} size="sm" />
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          {server.primaryAddress ? (
            <span className="hidden truncate font-mono text-caption text-label-tertiary sm:inline">
              {server.primaryAddress}
            </span>
          ) : null}
          <StatusPill status={server.status} />
        </>
      ),
    }));

    const navItems = [...PRIMARY_NAV, ...(isAdmin ? ADMIN_NAV : [])];
    const pages: PaletteEntry[] = [
      ...navItems.map((item) => {
        const Icon = item.icon;
        return {
          id: `page:${item.to}`,
          label: item.label,
          keywords: item.to.replace(/\//g, ' '),
          group: 'pages' as const,
          to: item.to,
          render: () => (
            <>
              <Icon aria-hidden />
              <span className="flex-1 truncate">{item.label}</span>
            </>
          ),
        };
      }),
      {
        id: 'page:/account',
        label: 'Profile and security',
        keywords: 'account password two factor totp api key theme',
        group: 'pages' as const,
        to: '/account',
        render: () => <span className="flex-1 truncate">Profile and security</span>,
      },
    ];

    return [...servers, ...pages];
  }, [data, isAdmin]);

  const filtered = useMemo(() => entries.filter((entry) => matches(entry, query)), [entries, query]);

  const collection = useMemo(
    () =>
      createListCollection({
        items: filtered,
        itemToValue: (entry) => entry.id,
        itemToString: (entry) => entry.label,
      }),
    [filtered],
  );

  const run = useCallback(
    (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return;
      close();
      void navigate(entry.to);
    },
    [close, entries, navigate],
  );

  const servers = filtered.filter((entry) => entry.group === 'servers');
  const pages = filtered.filter((entry) => entry.group === 'pages');

  return (
    <CommandDialog
      onOpenChange={({ open }) => {
        if (!open) {
          close();
          setQuery('');
        }
      }}
      open={isOpen}
    >
      <CommandDialogContent
        description="Search your servers and jump to any page."
        title="Search Platter"
      >
        <Command
          collection={collection}
          inputValue={query}
          onInputValueChange={({ inputValue }) => setQuery(inputValue)}
          onSelect={({ itemValue }) => run(itemValue)}
        >
          <ComboboxControl className="mb-2">
            <InputGroup className="h-11 rounded-md" size="lg">
              <InputGroupAddon>
                <Search aria-hidden className="text-label-tertiary" />
              </InputGroupAddon>
              <ArkCombobox.Input asChild data-slot="command-input">
                <InputGroupInput
                  aria-label="Search servers and pages"
                  autoFocus
                  className="h-11 text-body"
                  placeholder="Search servers and pages…"
                />
              </ArkCombobox.Input>
            </InputGroup>
          </ComboboxControl>

          <CommandContent>
            <CommandList>
              <CommandEmpty>
                Nothing matches “{query}”. Try a server name, or “new server”.
              </CommandEmpty>

              {servers.length > 0 ? (
                <CommandGroup heading="Servers">
                  {servers.map((entry) => (
                    <CommandItem className="h-11 gap-3 px-2" item={entry} key={entry.id}>
                      {entry.render()}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {pages.length > 0 ? (
                <CommandGroup heading="Go to">
                  {pages.map((entry) => (
                    <CommandItem className="h-11 gap-3 px-2" item={entry} key={entry.id}>
                      {entry.render()}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </CommandContent>

          <CommandFooter>
            <KbdGroup>
              <Kbd variant="outline">↑</Kbd>
              <Kbd variant="outline">↓</Kbd>
              <span>to move</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd variant="outline">↵</Kbd>
              <span>to open</span>
              <Kbd variant="outline">esc</Kbd>
              <span>to close</span>
            </KbdGroup>
          </CommandFooter>
        </Command>
      </CommandDialogContent>
    </CommandDialog>
  );
}
