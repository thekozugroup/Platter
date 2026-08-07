'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { heapForContainer, type ServerSettings, type ServerStatus } from '@platter/shared';
import { useState, useTransition } from 'react';
import { CopyableValue } from '@/components/copyable-value';
import { applySettingsAction, updateSettingsAction } from '@/lib/actions';

/**
 * Server settings.
 *
 * Split by *when the change takes effect*, not by topic. Some settings apply live over RCON,
 * some need `server.properties` rewritten (a container rebuild), and resource limits need the
 * container recreated outright. Grouping by topic would scatter those three behaviours through
 * every section and leave people guessing why one change worked immediately and the next did
 * nothing until a restart.
 */
export function SettingsForm({
  serverId,
  status,
  settings,
  memoryMiB,
  cpus,
  rconPort,
  rconPassword,
  dataDir,
}: {
  serverId: string;
  status: ServerStatus;
  settings: ServerSettings;
  memoryMiB: number;
  cpus: number;
  rconPort: number | null;
  rconPassword: string;
  dataDir: string;
}) {
  const [pending, startTransition] = useTransition();
  const showToast = useToast();

  const [motd, setMotd] = useState(settings.motd);
  const [difficulty, setDifficulty] = useState(settings.difficulty);
  const [gameMode, setGameMode] = useState(settings.gameMode);
  const [maxPlayers, setMaxPlayers] = useState(settings.maxPlayers);
  const [viewDistance, setViewDistance] = useState(settings.viewDistance);
  const [simulationDistance, setSimulationDistance] = useState(settings.simulationDistance);
  const [pvp, setPvp] = useState(settings.pvp);
  const [allowFlight, setAllowFlight] = useState(settings.allowFlight);
  const [enableCommandBlock, setEnableCommandBlock] = useState(settings.enableCommandBlock);
  const [whitelistEnabled, setWhitelistEnabled] = useState(settings.whitelistEnabled);
  const [onlineMode, setOnlineMode] = useState(settings.onlineMode);
  const [memory, setMemory] = useState(memoryMiB);
  const [cores, setCores] = useState(cpus);

  const resourcesChanged = memory !== memoryMiB || cores !== cpus;
  const running = status === 'running' || status === 'unhealthy';

  const save = () => {
    startTransition(async () => {
      const form = new FormData();
      form.set('motd', motd);
      form.set('difficulty', difficulty);
      form.set('gameMode', gameMode);
      form.set('maxPlayers', String(maxPlayers));
      form.set('viewDistance', String(viewDistance));
      form.set('simulationDistance', String(simulationDistance));
      form.set('pvp', pvp ? 'on' : '');
      form.set('allowFlight', allowFlight ? 'on' : '');
      form.set('enableCommandBlock', enableCommandBlock ? 'on' : '');
      form.set('whitelistEnabled', whitelistEnabled ? 'on' : '');
      form.set('onlineMode', onlineMode ? 'on' : '');
      form.set('__booleans', 'pvp,allowFlight,enableCommandBlock,whitelistEnabled,onlineMode');
      if (resourcesChanged) {
        form.set('memoryMiB', String(memory));
        form.set('cpus', String(cores));
      }

      const result = await updateSettingsAction(serverId, { ok: true }, form);
      showToast({
        body: result.message ?? (result.ok ? 'Saved.' : 'Could not save.'),
        type: result.ok ? 'info' : 'error',
      });
    });
  };

  return (
    <VStack gap={5} maxWidth={720}>
      <Section variant="transparent">
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Gameplay</Heading>
            <Text type="supporting">
              Difficulty, game mode and the whitelist apply immediately on a running server.
              Everything else here takes effect on the next restart.
            </Text>
          </VStack>

          <FormLayout>
            <TextInput label="Message of the day" value={motd} onChange={setMotd} />
            <FormLayout direction="horizontal">
              <Selector
                label="Difficulty"
                value={difficulty}
                onChange={(value) => setDifficulty(value as ServerSettings['difficulty'])}
                options={[
                  { value: 'peaceful', label: 'Peaceful' },
                  { value: 'easy', label: 'Easy' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'hard', label: 'Hard' },
                ]}
                description={running ? 'Applies immediately' : undefined}
              />
              <Selector
                label="Game mode"
                value={gameMode}
                onChange={(value) => setGameMode(value as ServerSettings['gameMode'])}
                options={[
                  { value: 'survival', label: 'Survival' },
                  { value: 'creative', label: 'Creative' },
                  { value: 'adventure', label: 'Adventure' },
                  { value: 'spectator', label: 'Spectator' },
                ]}
                description={running ? 'Applies immediately' : undefined}
              />
            </FormLayout>

            <FormLayout direction="horizontal">
              <NumberInput
                label="Max players"
                value={maxPlayers}
                onChange={setMaxPlayers}
                min={1}
                max={200}
              />
              <NumberInput
                label="View distance"
                value={viewDistance}
                onChange={setViewDistance}
                min={3}
                max={32}
                description="Chunks. The biggest lever on CPU use."
              />
              <NumberInput
                label="Simulation distance"
                value={simulationDistance}
                onChange={setSimulationDistance}
                min={3}
                max={32}
                description="Chunks that tick. Keep at or below view distance."
              />
            </FormLayout>

            <Switch label="PvP" value={pvp} onChange={setPvp} />
            <Switch label="Allow flight" value={allowFlight} onChange={setAllowFlight} />
            <Switch
              label="Command blocks"
              value={enableCommandBlock}
              onChange={setEnableCommandBlock}
            />
            <Switch
              label="Whitelist"
              value={whitelistEnabled}
              onChange={setWhitelistEnabled}
              description={
                running ? 'Applies immediately' : 'Only listed players can join once enabled.'
              }
            />
            <Switch
              label="Require Minecraft accounts"
              value={onlineMode}
              onChange={setOnlineMode}
              description="Turning this off lets cracked clients join. Private networks only."
            />
          </FormLayout>
        </VStack>
      </Section>

      <Section variant="transparent">
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Resources</Heading>
            <Text type="supporting">
              Changing these rebuilds the container. The world, mods and address are untouched.
            </Text>
          </VStack>

          <FormLayout direction="horizontal">
            <NumberInput
              label="Memory (MB)"
              value={memory}
              onChange={setMemory}
              min={1024}
              max={65_536}
              step={512}
              description={`${heapForContainer(memory)} MB heap`}
            />
            <NumberInput
              label="CPU cores"
              value={cores}
              onChange={setCores}
              min={0.5}
              max={32}
              step={0.5}
            />
          </FormLayout>

          {resourcesChanged && running ? (
            <Banner
              status="warning"
              title="This will restart the server"
              description="Players will be disconnected while the container is rebuilt."
            />
          ) : null}
        </VStack>
      </Section>

      <Section variant="transparent">
        <VStack gap={4}>
          <Heading level={2}>Advanced</Heading>
          <Card padding={4}>
            <VStack gap={4}>
              <CopyableValue label="Data directory" value={dataDir} />
              {rconPort ? (
                <>
                  <CopyableValue label="RCON port" value={`127.0.0.1:${rconPort}`} />
                  <CopyableValue label="RCON password" value={rconPassword} secret />
                </>
              ) : null}
              <Text type="supporting">
                RCON is bound to loopback only. It grants full control of the server, so treat the
                password like a root password and never forward the port.
              </Text>
            </VStack>
          </Card>

          <HStack gap={2}>
            <Button
              label="Rebuild container"
              variant="secondary"
              isDisabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const result = await applySettingsAction(serverId);
                  showToast({
                    body: result.ok
                      ? 'Container rebuilt with the current settings.'
                      : (result.message ?? 'Could not rebuild.'),
                    type: result.ok ? 'info' : 'error',
                  });
                });
              }}
            />
            <Text type="supporting">
              Applies every stored setting by recreating the container from scratch.
            </Text>
          </HStack>
        </VStack>
      </Section>

      <HStack gap={2}>
        <Button
          label="Save changes"
          variant="primary"
          isLoading={pending}
          isDisabled={pending}
          onClick={save}
        />
      </HStack>
    </VStack>
  );
}
