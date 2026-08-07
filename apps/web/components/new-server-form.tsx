'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import {
  LOADER_LABELS,
  type MinecraftLoader,
  heapForContainer,
  requiredJavaVersion,
} from '@platter/shared';
import { useActionState, useMemo, useState } from 'react';
import { type ActionState, createServerAction } from '@/lib/actions';

export interface NewServerFormProps {
  versions: { version: string; major: boolean }[];
  defaultVersion: string;
  loadersByVersion: Record<string, MinecraftLoader[]>;
  loaderBlurbs: Record<MinecraftLoader, string>;
}

const INITIAL: ActionState = { ok: true };

/**
 * Server creation.
 *
 * One screen, not a wizard. A wizard is the right shape when later steps depend on earlier ones
 * in ways the user cannot predict; here everything has a sensible default and the only genuinely
 * required decision is a name. Making people click "Next" four times to accept defaults is
 * friction pretending to be guidance.
 *
 * What the form does do is *show its reasoning*: as you pick a version it tells you which Java
 * it will use and how much heap the JVM gets, because those are exactly the two things people
 * get wrong by hand and then spend an evening debugging.
 */
export function NewServerForm({
  versions,
  defaultVersion,
  loadersByVersion,
  loaderBlurbs,
}: NewServerFormProps) {
  const [state, formAction, pending] = useActionState(createServerAction, INITIAL);

  const [name, setName] = useState('');
  const [gameVersion, setGameVersion] = useState(defaultVersion);
  const [loader, setLoader] = useState<MinecraftLoader>('paper');
  const [memoryMiB, setMemoryMiB] = useState(4096);
  const [cpus, setCpus] = useState(2);
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [motd, setMotd] = useState('');
  const [difficulty, setDifficulty] = useState('normal');
  const [gameMode, setGameMode] = useState('survival');
  const [levelSeed, setLevelSeed] = useState('');
  const [onlineMode, setOnlineMode] = useState(true);
  const [acceptEula, setAcceptEula] = useState(false);

  const loaders = loadersByVersion[gameVersion] ?? ['vanilla', 'paper', 'fabric'];

  // The chosen loader may not exist for a newly chosen version — NeoForge before 1.20.1, Folia
  // before 1.19.4. Fall back rather than submitting something that would 404 during install.
  const effectiveLoader = loaders.includes(loader) ? loader : (loaders[0] ?? 'vanilla');

  const javaVersion = useMemo(() => requiredJavaVersion(gameVersion), [gameVersion]);
  const heapMiB = useMemo(() => heapForContainer(memoryMiB), [memoryMiB]);

  return (
    <form action={formAction}>
      <VStack gap={5} maxWidth={720}>
        {state.ok === false && state.message ? (
          <Banner status="error" title="Couldn't create the server" description={state.message} />
        ) : null}

        <Section variant="transparent">
          <VStack gap={4}>
            <Heading level={2}>Basics</Heading>
            <FormLayout>
              <TextInput
                label="Name"
                htmlName="name"
                value={name}
                onChange={setName}
                placeholder="Survival with friends"
                isRequired
                description="Shown in the sidebar. You can change it later."
                {...(state.fieldErrors?.name
                  ? { status: { type: 'error' as const, message: state.fieldErrors.name } }
                  : {})}
              />

              <Selector
                label="Minecraft version"
                htmlName="gameVersion"
                value={gameVersion}
                onChange={setGameVersion}
                hasSearch
                searchPlaceholder="Find a version"
                options={versions.map((entry) => ({
                  value: entry.version,
                  label: entry.version,
                  ...(entry.major ? { description: 'Major release' } : {}),
                }))}
                description={`Runs on Java ${javaVersion}. Platter picks the image for you.`}
              />

              <Selector
                label="Server type"
                htmlName="loader"
                value={effectiveLoader}
                onChange={(value) => setLoader(value as MinecraftLoader)}
                options={loaders.map((entry) => ({
                  value: entry,
                  label: LOADER_LABELS[entry],
                  description: loaderBlurbs[entry],
                }))}
                description={
                  loaders.includes(loader)
                    ? undefined
                    : `${LOADER_LABELS[loader]} has no builds for ${gameVersion}.`
                }
              />
            </FormLayout>
          </VStack>
        </Section>

        <Section variant="transparent">
          <VStack gap={4}>
            <Heading level={2}>Resources</Heading>
            <FormLayout direction="horizontal">
              <NumberInput
                label="Memory (MB)"
                htmlName="memoryMiB"
                value={memoryMiB}
                onChange={setMemoryMiB}
                min={1024}
                max={65_536}
                step={512}
                description={`${heapMiB} MB heap, the rest for the JVM itself.`}
              />
              <NumberInput
                label="CPU cores"
                htmlName="cpus"
                value={cpus}
                onChange={setCpus}
                min={0.5}
                max={32}
                step={0.5}
                description="A hard ceiling, not a reservation."
              />
              <NumberInput
                label="Max players"
                htmlName="maxPlayers"
                value={maxPlayers}
                onChange={setMaxPlayers}
                min={1}
                max={200}
              />
            </FormLayout>

            <Card variant="muted" padding={3}>
              <Text type="supporting">
                {sizingAdvice(memoryMiB, effectiveLoader)}
              </Text>
            </Card>
          </VStack>
        </Section>

        <Section variant="transparent">
          <VStack gap={4}>
            <Heading level={2}>World</Heading>
            <FormLayout>
              <TextInput
                label="Message of the day"
                htmlName="motd"
                value={motd}
                onChange={setMotd}
                placeholder={name ? `A ${name} server` : 'A Platter server'}
                isOptional
              />
              <FormLayout direction="horizontal">
                <Selector
                  label="Difficulty"
                  htmlName="difficulty"
                  value={difficulty}
                  onChange={setDifficulty}
                  options={[
                    { value: 'peaceful', label: 'Peaceful' },
                    { value: 'easy', label: 'Easy' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'hard', label: 'Hard' },
                  ]}
                />
                <Selector
                  label="Game mode"
                  htmlName="gameMode"
                  value={gameMode}
                  onChange={setGameMode}
                  options={[
                    { value: 'survival', label: 'Survival' },
                    { value: 'creative', label: 'Creative' },
                    { value: 'adventure', label: 'Adventure' },
                    { value: 'spectator', label: 'Spectator' },
                  ]}
                />
              </FormLayout>
              <TextInput
                label="World seed"
                htmlName="levelSeed"
                value={levelSeed}
                onChange={setLevelSeed}
                isOptional
                description="Leave blank for a random world."
              />
              <Switch
                label="Require Minecraft accounts"
                htmlName="onlineMode"
                value={onlineMode}
                onChange={setOnlineMode}
                description="Turning this off lets cracked clients join. Only do this on a private network."
              />
            </FormLayout>
          </VStack>
        </Section>

        <Section variant="transparent">
          <VStack gap={3}>
            <CheckboxList
              label="Licence"
              isLabelHidden
              value={acceptEula ? ['acceptEula'] : []}
              onChange={(values) => setAcceptEula(values.includes('acceptEula'))}
            >
              <CheckboxListItem
                value="acceptEula"
                label="I accept the Minecraft End User Licence Agreement"
                description="Required by Mojang to run a server. Read it at aka.ms/MinecraftEULA."
              />
            </CheckboxList>
            {/* CheckboxList is controlled and does not post a value, so the form carries it. */}
            <input type="hidden" name="acceptEula" value={acceptEula ? 'on' : ''} />
            {state.fieldErrors?.acceptEula ? (
              <Text type="supporting" color="accent">
                {state.fieldErrors.acceptEula}
              </Text>
            ) : null}
          </VStack>
        </Section>

        <HStack gap={2} justify="start">
          <Button
            label={pending ? 'Creating…' : 'Create server'}
            variant="primary"
            type="submit"
            isLoading={pending}
            isDisabled={!acceptEula || name.trim().length === 0}
          />
          <Button label="Cancel" variant="ghost" href="/" />
        </HStack>
      </VStack>
    </form>
  );
}

/**
 * Memory guidance.
 *
 * Sizing is the other thing people get wrong, and the failure is silent until the server is
 * mid-session: too little and the JVM spends its time in GC, which reads as lag rather than as
 * a memory problem. The numbers are the community-standard rules of thumb.
 */
function sizingAdvice(memoryMiB: number, loader: MinecraftLoader): string {
  const gb = memoryMiB / 1024;
  const modded = loader === 'forge' || loader === 'neoforge' || loader === 'fabric' || loader === 'quilt';

  if (gb < 2) {
    return 'Under 2 GB is tight even for vanilla. Expect stutter once a few players spread out.';
  }
  if (modded && gb < 4) {
    return 'Modded servers want 4 GB or more. Below that, a large modpack will spend most of its time garbage collecting.';
  }
  if (gb >= 12) {
    return 'Above 12 GB, Platter switches to the large-heap variant of the Aikar GC flags automatically.';
  }
  return modded
    ? 'A reasonable starting point for a modded server. Watch the memory graph after a session and adjust.'
    : 'Comfortable for a vanilla or plugin server with a handful of players.';
}
