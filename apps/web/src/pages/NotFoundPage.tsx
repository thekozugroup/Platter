import { useLocation } from 'react-router';
import { EmptyState } from '@/components/common/empty-state';
import { PageBody } from '@/components/layout/page-header';

/**
 * 404, inside the shell.
 *
 * Keeping the sidebar means the way out is already on screen. It also names the address that
 * missed, which is the one piece of information that makes a stale bookmark obvious.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <>
      {/*
        The heading belongs to the empty state, not to both. Titling the page and the panel
        identically printed "Page not found" twice, one above the other.
      */}
      <PageBody>
        <EmptyState
          action={{ label: 'Go to the dashboard', to: '/' }}
          secondaryAction={{ label: 'See all servers', to: '/servers' }}
          description={
            <>
              No page exists at <code className="font-mono text-label">{pathname}</code>. The link
              may be out of date, or the item may have been deleted.
            </>
          }
          title="Page not found"
        />
      </PageBody>
    </>
  );
}
