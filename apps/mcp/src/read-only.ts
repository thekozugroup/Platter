/**
 * Which console commands may run without asking the human.
 *
 * The confirmation prompt is the mechanism the whole AI story rests on, so the exemption list in
 * front of it has to be narrow enough to defend one entry at a time. An earlier version keyed on
 * the bare verb, which let three genuinely dangerous commands through:
 *
 *   - `/datapack disable <name>` changes what the world loads on the next tick. That is the
 *     classic way to quietly break a modpack, and it looks identical to `/datapack list`.
 *   - `/debug function <fn>` *executes* an `.mcfunction` — an arbitrary command sequence,
 *     including `op`, `ban` and `kill @a`. Any datapack already on disk becomes a payload.
 *   - `/debug start` and `/perf start` write profiler dumps into the world's bind mount, with no
 *     bound and no rate limit.
 *
 * So the allowlist is keyed on the command *shape*, not the verb: the argument is what decides
 * whether a command reads or writes, and a policy that cannot see the argument cannot decide.
 *
 * Anything not matched here is treated as state-changing, which costs a confirmation prompt and
 * nothing else. That asymmetry is the right way round.
 */

/** For each safe verb, whether this particular argument list keeps it safe. */
const READ_ONLY: Record<string, (args: string[]) => boolean> = {
  // `/list` and `/list uuids`.
  list: (args) => args.length === 0 || args[0]?.toLowerCase() === 'uuids',
  seed: (args) => args.length === 0,
  // `/help` and `/help <command>` both only print.
  help: () => true,
  // Vanilla takes no argument; Bukkit's `/version <plugin>` prints one plugin's version.
  version: (args) => args.length <= 1,
  tps: (args) => args.length === 0,
  mspt: (args) => args.length === 0,
  plugins: (args) => args.length === 0,
  pl: (args) => args.length === 0,
  mods: (args) => args.length === 0,
  banlist: (args) => args.length === 0 || ['players', 'ips'].includes(args[0]?.toLowerCase() ?? ''),
  // Only the list subcommand. `enable`/`disable` change what the world loads.
  whitelist: (args) => args.length === 1 && args[0]?.toLowerCase() === 'list',
  datapack: (args) => args.length === 1 && args[0]?.toLowerCase() === 'list',
};

/**
 * Can this command run without confirmation?
 *
 * Takes the command as the user typed it, leading slash optional. A multi-line string is never
 * read-only regardless of content — `sendCommand` rejects those outright, and answering "yes,
 * safe" about a string that contains three commands is exactly the mistake this file exists to
 * stop making.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim().replace(/^\//, '').trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }
  const [verb, ...args] = trimmed.split(/\s+/);
  const rule = READ_ONLY[verb?.toLowerCase() ?? ''];
  return rule?.(args) ?? false;
}
