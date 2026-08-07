import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';

/**
 * The 404 for anything inside the app shell.
 *
 * Reached almost exclusively by one route: a bookmarked or shared link to a server that has
 * since been deleted. Next's built-in 404 renders outside the shell with no navigation, which
 * turns "that server is gone" into "the app is broken". This keeps the sidebar — so the other
 * servers are one click away — and says which of the two actually happened.
 */
export default function AppNotFound() {
  return (
    <Layout height="fill">
      <LayoutContent padding={5}>
        <EmptyState
          title="That server isn't here"
          description="It may have been deleted, or the link may be wrong. Everything else is where you left it."
          actions={<Button label="Go to the dashboard" variant="primary" href="/" />}
        />
      </LayoutContent>
    </Layout>
  );
}
