'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useEffect } from 'react';

/**
 * The error boundary for every page inside the app shell.
 *
 * Without one, any throw during render — or any server action that throws instead of returning
 * a failed `Result` — replaces the entire app with Next's unstyled "This page couldn't load"
 * screen: no sidebar, no navigation, no way back except the browser's own controls. That is a
 * dead end in a tool whose whole value is being able to see what state your servers are in.
 *
 * Living inside the `(app)` group means the shell survives: the sidebar is still there, the
 * other servers are still reachable, and only the failed pane is replaced.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server-side digest is what correlates this with the process log; the message alone
    // is often scrubbed in production builds.
    console.error('Platter page error', error);
  }, [error]);

  return (
    <Layout height="fill">
      <LayoutContent padding={5}>
        <VStack gap={4} maxWidth={640}>
          <Banner
            status="error"
            title="Something went wrong on this page"
            description={error.message || 'The page could not be rendered.'}
          />
          <Text type="supporting">
            Your servers and worlds are unaffected — this is a problem displaying the page, not
            running the games. Trying again is safe.
            {error.digest ? ` Reference: ${error.digest}.` : ''}
          </Text>
          <HStack gap={2}>
            <Button label="Try again" variant="primary" onClick={reset} />
            <Button label="Go to the dashboard" variant="secondary" href="/" />
          </HStack>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
