import { Banner } from '@astryxdesign/core/Banner';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * Docker being down is an ordinary state for a local app, not an exception.
 *
 * It gets a real explanation with the exact command to fix it. Every page that needs a Docker
 * connection renders this — the dashboard always did, but the server pages called `notFound()`
 * instead, so stopping Docker and opening a bookmarked server produced Next's built-in 404:
 * black-and-white "This page could not be found", no sidebar, no explanation, and the strong
 * implication that the server had been deleted. The engine being off is the single most common
 * reason a local Docker app cannot answer, and it is the one thing a 404 categorically fails to
 * communicate.
 */
export function DockerUnavailable({ message }: { message: string }) {
  return (
    <Layout height="fill">
      <LayoutContent padding={5}>
        <VStack gap={4} maxWidth={640}>
          <Banner status="error" title="Platter can't reach Docker" description={message} />
          <Text type="supporting">
            Platter runs every game server in its own container, so it needs a running Docker
            engine. Start Docker Desktop, Colima, OrbStack or `sudo systemctl start docker`, then
            reload this page. Your servers and worlds are untouched — they live on disk, not in
            Docker.
          </Text>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
