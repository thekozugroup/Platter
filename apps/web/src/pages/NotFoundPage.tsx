import { useLocation } from 'react-router';
import { EmptyState } from '@/components/common/empty-state';
import { PageBody, PageHeader } from '@/components/layout/page-header';

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
      <PageHeader title="No page here" />
      <PageBody>
        <EmptyState
          action={{ label: 'Go to the dashboard', to: '/' }}
          secondaryAction={{ label: 'See all servers', to: '/servers' }}
          description={
            <>
              Nothing is routed at <code className="font-mono text-label">{pathname}</code>. The
              link may be out of date, or whatever lived here has been deleted.
            </>
          }
          title="That address doesn’t exist"
        />
      </PageBody>
    </>
  );
}
