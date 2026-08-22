import { Link } from 'react-router';
import { CopyField } from '@/components/common/copy-field';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * How to point an AI assistant at this Platter.
 *
 * This exists because the connection details were only in the README. Someone running
 * Platter had no way to discover from inside the product that it could be driven by an
 * assistant at all, let alone how — so the feature the panel is built around was invisible
 * to everyone who did not read the repository.
 */

const SECTION_TITLE = 'font-sans text-title-3 font-semibold';

function stdioConfig(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        platter: {
          command: 'docker',
          args: ['exec', '-i', 'platter', 'node', 'apps/api/dist/mcp/cli.js'],
          env: { PLATTER_API_KEY: 'plt_your_key_here' },
        },
      },
      // Kept as a comment-free second entry rather than prose: an MCP client reads JSON.
      _httpAlternative: { url: `${origin}/api/v1/mcp` },
    },
    null,
    2,
  );
}

export function McpPage() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <PageHeader description="Connect an AI assistant to this Platter." title="AI and MCP" />
      <PageBody className="flex flex-col gap-8">
        <Card>
          <CardHeader>
            <CardTitle className={SECTION_TITLE}>What an assistant can do</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex list-disc flex-col gap-2 ps-5 text-subhead text-label-secondary">
              <li>Create servers, start and stop them, and read their logs.</li>
              <li>Watch performance and explain why something crashed.</li>
              <li>Manage players — whitelist, kick, ban.</li>
              <li>Suggest mods for you to approve.</li>
            </ul>
            <Alert>
              <AlertTitle className="font-sans">It cannot install a mod</AlertTitle>
              <AlertDescription>
                An assistant can only propose one. You see what it picked, who made it and what it
                pulls in, and nothing reaches the server until you approve it.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className={SECTION_TITLE}>Connect</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <ol className="flex list-decimal flex-col gap-3 ps-5 text-subhead text-label-secondary">
              <li>
                Create an API key on{' '}
                <Link className="underline underline-offset-2" to="/account">
                  your account page
                </Link>
                . Give it only the permissions you want the assistant to have.
              </li>
              <li>
                Paste this into your assistant’s MCP settings, with the key in place of the
                placeholder.
              </li>
              <li>Ask it to list your servers. If it can see them, you are connected.</li>
            </ol>

            <CopyField label="MCP client configuration" showLabel value={stdioConfig(origin)} />

            <div className="flex flex-col gap-1">
              <p className="text-subhead font-medium text-label">This Platter’s address</p>
              <CopyField label="Platter address" value={origin} />
            </div>

            <Button asChild className="w-fit rounded-button" variant="outline">
              <Link to="/account">Create an API key</Link>
            </Button>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
