import { Link } from 'react-router';
import { CopyBlock, CopyField } from '@/components/common/copy-field';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * How to point an AI assistant at this Platter.
 *
 * This exists because the connection details were only in the README. Someone running
 * Platter had no way to discover from inside the product that it could be driven by an
 * assistant at all, let alone how — so the feature the panel is built around was invisible
 * to everyone who did not read the repository.
 *
 * The page carries three things, and the order is the order someone does them in: what the
 * assistant will be able to do, how to connect it, and what to say to it once connected.
 * The third was missing, and it is the one that decides whether the first two are any use:
 * a connected agent with no brief will happily send `op` to a production server because
 * somebody in chat asked it to.
 */

const SECTION_TITLE = 'font-sans text-title-3 font-semibold';

/**
 * The stdio transport, which is what most desktop clients speak.
 *
 * `docker exec` into the running container rather than a published binary: the MCP server
 * is the same process tree as the panel, so this needs nothing installed and no port
 * exposed beyond the one Platter already listens on.
 */
function stdioConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        platter: {
          command: 'docker',
          args: ['exec', '-i', 'platter', 'node', 'apps/api/dist/mcp/cli.js'],
          env: { PLATTER_API_KEY: 'plt_your_key_here' },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The streamable HTTP transport, for a client that is not on this machine.
 *
 * The key goes in a header. It used to be shown as a bare `url` with no credential at all,
 * which is not a configuration any client can connect with — the server answers every
 * unauthenticated call with a 401 that says exactly this.
 */
function httpConfig(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        platter: {
          type: 'http',
          url: `${origin}/api/v1/mcp`,
          headers: { 'X-API-Key': 'plt_your_key_here' },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The brief an operator hands their assistant.
 *
 * Written in the operator's voice, because that is who is pasting it, and it has to survive
 * being the only thing the assistant is told. Four things earn their place:
 *
 *   - What it can do, so it stops guessing and starts with the right tool.
 *   - The approval boundary, because `propose_mod` is the whole reason mods are safe here
 *     and an agent that does not know about it will tell the person it installed something.
 *   - `send_console_command`, called out by name: it is the one tool that acts immediately
 *     with no confirmation argument, and `op` and `ban` go through it.
 *   - The loader trap, which is the most common way an agent gets Minecraft wrong and the
 *     failure is silent — a Fabric mod on a Paper server simply never loads.
 */
function agentPrompt(origin: string): string {
  return `You are looking after my game servers through Platter, a self-hosted control panel at ${origin}. You have its MCP tools.

What you can do: create and delete servers; start, stop and restart them; send console commands; read and search their logs; diagnose crashes; read live metrics and history; manage the whitelist, kicks and bans; and propose mods for me to approve.

Four rules, which matter more than being quick:

1. You cannot install anything. propose_mod writes a proposal I approve in the web interface, and no tool here writes a file. Propose the mod, then tell me what to check before I approve it — the licence, whether it is still maintained, and what it pulls in with it. Never tell me a mod is installed; tell me it is waiting for me.
2. send_console_command runs immediately. It has no confirmation step, and op, ban, gamemode and world edits all go through it. Ask me before sending anything that changes game state or who has power on the server; read-only commands are fine to send.
3. The destructive tools refuse to act until you pass their confirmation argument. That refusal is the feature: read back what the tool says it would do, and confirm only the thing I actually asked for. Deleting a server destroys its worlds and cannot be undone.
4. You act as my account through one API key. A server you cannot see is one you have no access to, and every write is recorded in the audit log under your name. If a tool says you lack a permission, tell me — do not look for another route to the same effect.

Start with list_servers and list_blueprints before changing anything.

For Minecraft, read get_blueprint("minecraft-java") before you pick a server type. Paper takes Bukkit plugins; Fabric and NeoForge take mods; they are not interchangeable. Choose wrong and every mod I ask for afterwards silently does nothing.

When something is broken, run diagnose_crash first, then get_logs or search_logs for the lines it points at. Tell me the cause in one sentence before you propose a fix.

Ask me first before creating or deleting a server. For everything else, go ahead and then tell me what you did.`;
}

/** The six jobs the twenty-five tools group into, named so an operator can ask for them. */
const CAPABILITIES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: 'Find its way around', detail: 'Lists your servers, and the games it can create.' },
  { title: 'Run them', detail: 'Start, stop, restart, and send a console command.' },
  { title: 'Read them', detail: 'Live status, recent logs, log search, metrics over time.' },
  { title: 'Explain a crash', detail: 'Reads the exit and the lines around it, and says why.' },
  { title: 'Manage players', detail: 'Whitelist, kick and ban, where the game supports it.' },
  { title: 'Suggest mods', detail: 'Searches the registries and proposes. Never installs.' },
];

export function McpPage() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <PageHeader description="Connect an AI assistant to this installation." title="AI and MCP" />
      <PageBody className="flex flex-col gap-8">
        <Card>
          <CardHeader>
            <CardTitle className={SECTION_TITLE}>What an assistant can do</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {CAPABILITIES.map((capability) => (
                <div key={capability.title}>
                  <dt className="text-subhead font-medium text-label">{capability.title}</dt>
                  <dd className="text-subhead text-label-secondary">{capability.detail}</dd>
                </div>
              ))}
            </dl>
            <Alert>
              <AlertTitle className="font-sans">Mods require your approval</AlertTitle>
              <AlertDescription>
                An assistant can only propose a mod. The proposal shows what was chosen, who made it
                and what it depends on. Nothing reaches the server until it is approved.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className={SECTION_TITLE}>Connect</CardTitle>
            <CardDescription>
              Two transports. Use stdio for an assistant on this machine, HTTP for one that is not.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <ol className="flex list-decimal flex-col gap-3 ps-5 text-subhead text-label-secondary">
              <li>
                Create an API key on{' '}
                <Link className="underline underline-offset-2" to="/account">
                  your account page
                </Link>
                , choosing what the assistant is allowed to do.
              </li>
              <li>Paste one of these into your assistant’s MCP settings, with the key in place.</li>
              <li>Ask it to list your servers. If they appear, the connection works.</li>
            </ol>

            <CopyBlock
              label="MCP configuration over stdio"
              maxHeightClass="max-h-64"
              showLabel
              value={stdioConfig()}
            />
            <CopyBlock
              label="MCP configuration over HTTP"
              maxHeightClass="max-h-64"
              showLabel
              value={httpConfig(origin)}
            />

            <div className="flex flex-col gap-1">
              <p className="text-subhead font-medium text-label">This Platter’s address</p>
              <CopyField label="Platter address" value={origin} />
            </div>

            <Button asChild className="w-fit rounded-button" variant="outline">
              <Link to="/account">Create an API key</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className={SECTION_TITLE}>Give your assistant this prompt</CardTitle>
            <CardDescription>
              Connecting the tools is half of it. This is the other half: what the assistant is for,
              and where it has to stop and ask you.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CopyBlock label="Agent prompt" value={agentPrompt(origin)} />
            <p className="max-w-prose text-caption text-label-tertiary">
              Edit it to suit. The rules about approval, console commands and destructive tools
              describe how Platter actually behaves — an assistant that has not been told them will
              still be refused, but it will not know why.
            </p>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
