import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS, formatMegabytes, type Blueprint, type Node, type Server } from '@platter/shared';
import { GameIcon } from '@/components/common/game-icon';
import { ErrorState } from '@/components/common/error-state';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { BlueprintPicker, useBlueprint } from '@/components/servers/blueprint-picker';
import {
  MinecraftTypePicker,
  RECOMMENDED_TYPE,
  TYPE_VARIABLE_KEY,
  hasMinecraftTypePicker,
  minecraftTypeLabel,
} from '@/components/servers/minecraft-type-picker';
import {
  ResourceFields,
  clampResources,
  defaultResources,
  resourceBounds,
  type ResourceCapacity,
  type ResourceValue,
} from '@/components/servers/resource-fields';
import {
  VariableFields,
  defaultVariableValues,
  variableErrors,
  type VariableValues,
} from '@/components/servers/variable-fields';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Steps,
  StepsContent,
  StepsIndicator,
  StepsItem,
  StepsList,
  StepsSeparator,
  StepsTitle,
  StepsTrigger,
} from '@/components/ui/steps';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { queryKeys } from '@/lib/query.js';
import { serverNameProblem } from '@/lib/server-name.js';

/**
 * Create a server.
 *
 * This flow decides whether Platter feels like magic or like paperwork, and it has to work for
 * someone who has never run a server. So it asks for four things, in the order a person
 * actually decides them — which game, which kind of that game, what to call it and how big, and
 * finally the settings — and never asks for anything the blueprint can answer itself.
 *
 * Validation happens as you type, not on submit. Every "Next" that is unavailable says why in
 * text next to the button, because a greyed-out button with no explanation is the single most
 * common dead end in a setup wizard.
 */

type StepKey = 'game' | 'type' | 'details' | 'settings';

interface StepDefinition {
  key: StepKey;
  title: string;
  /** Shown under the heading of the step's own panel. */
  blurb: string;
}

/**
 * Advanced variables that stop being advanced once a particular server type is chosen. Picking
 * "CurseForge pack" and then having to open a disclosure to say *which* pack would be absurd.
 */
const PROMOTED_BY_TYPE: Record<string, readonly string[]> = {
  AUTO_CURSEFORGE: ['CF_SLUG', 'CF_PAGE_URL', 'CF_FILE_ID', 'CF_API_KEY'],
  MODRINTH: ['MODRINTH_MODPACK', 'MODRINTH_VERSION', 'MODRINTH_LOADER'],
  FTBA: ['FTB_MODPACK_ID', 'FTB_MODPACK_VERSION_ID'],
  CUSTOM: ['CUSTOM_SERVER', 'CUSTOM_JAR_EXEC'],
  FABRIC: ['FABRIC_LOADER_VERSION'],
  FORGE: ['FORGE_VERSION'],
  NEOFORGE: ['NEOFORGE_VERSION'],
  QUILT: ['QUILT_LOADER_VERSION'],
  PAPER: [],
};

/** The node with the most memory spare, which is where the API will most likely place this. */
function pickCapacity(nodes: readonly Node[]): ResourceCapacity | null {
  const online = nodes.filter((node) => node.status === 'online');
  const pool = online.length > 0 ? online : nodes;
  const first = pool[0];
  if (!first) return null;

  const freeMemory = (node: Node) =>
    Math.max(0, Math.floor(node.memoryTotalMb * node.overcommitRatio) - node.memoryAllocatedMb);

  const best = pool.reduce(
    (winner, node) => (freeMemory(node) > freeMemory(winner) ? node : winner),
    first,
  );

  return {
    nodeName: best.name,
    memoryFreeMb: freeMemory(best),
    diskFreeMb: Math.max(0, best.diskTotalMb - best.diskAllocatedMb),
    cpuCores: best.cpuCores,
  };
}

// ---------------------------------------------------------------------------------------

export function CreateServerPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const [blueprintKey, setBlueprintKey] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [limits, setLimits] = useState<ResourceValue | null>(null);
  const [variables, setVariables] = useState<VariableValues>({});
  const [apiErrors, setApiErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const blueprintQuery = useBlueprint(blueprintKey);
  const blueprint: Blueprint | undefined = blueprintQuery.data;

  // `/nodes` is admin-only, so a member simply gets the blueprint's ranges rather than the
  // node's. The API still places the server and still refuses an allocation that will not fit.
  const nodesQuery = useQuery({
    queryKey: queryKeys.nodes.all,
    queryFn: () => api.get<{ data: Node[] }>('/nodes'),
    enabled: isAdmin,
    staleTime: 60_000,
  });

  const capacity = useMemo(
    () => (nodesQuery.data ? pickCapacity(nodesQuery.data.data) : null),
    [nodesQuery.data],
  );

  // Fresh defaults every time the game changes: the previous game's memory figure and its
  // variables are meaningless for the new one.
  useEffect(() => {
    if (!blueprint) return;
    setVariables(defaultVariableValues(blueprint.variables));
    setLimits(defaultResources(blueprint, capacity));
    setApiErrors({});
    setName((current) => (current === '' ? blueprint.game : current));
    // `capacity` is intentionally out of the dependency list: nodes refreshing must not throw
    // away a memory figure the operator has already dragged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprint?.key]);

  const typeVariable = useMemo(
    () => blueprint?.variables.find((variable) => variable.key === TYPE_VARIABLE_KEY) ?? null,
    [blueprint],
  );

  const showTypeStep =
    blueprintKey !== null &&
    hasMinecraftTypePicker(blueprintKey) &&
    typeVariable !== null &&
    typeVariable.type === 'enum';

  const steps = useMemo<StepDefinition[]>(() => {
    const list: StepDefinition[] = [
      {
        key: 'game',
        title: 'Game',
        blurb: 'Choose a game. Later steps and default settings depend on it.',
      },
    ];
    if (showTypeStep) {
      list.push({
        key: 'type',
        title: 'Server type',
        blurb: 'What the server accepts: plugins, mods, both, or none.',
      });
    }
    list.push(
      {
        key: 'details',
        title: 'Name and size',
        blurb: 'The server name and its resource limits.',
      },
      {
        key: 'settings',
        title: 'Settings',
        blurb: 'The game’s own options. Sensible defaults are already filled in.',
      },
    );
    return list;
  }, [showTypeStep]);

  // Dropping a step (switching away from Minecraft) must not leave the wizard past its end.
  useEffect(() => {
    setStepIndex((current) => Math.min(current, steps.length - 1));
  }, [steps.length]);

  const selectedType = variables[TYPE_VARIABLE_KEY] ?? RECOMMENDED_TYPE;
  const omitKeys = useMemo(() => (showTypeStep ? [TYPE_VARIABLE_KEY] : []), [showTypeStep]);
  const promoteKeys = showTypeStep ? (PROMOTED_BY_TYPE[selectedType] ?? []) : [];

  const bounds = useMemo(
    () => (blueprint ? resourceBounds(blueprint, capacity) : null),
    [blueprint, capacity],
  );

  const nameError = nameTouched ? serverNameProblem(name) : null;

  const settingsErrors = useMemo(() => {
    if (!blueprint) return {};
    const live = variableErrors(blueprint.variables, variables, omitKeys);
    // The API's own complaints win: it knows things the client cannot check.
    for (const [key, message] of Object.entries(apiErrors)) {
      if (key.startsWith('variables.')) live[key.slice('variables.'.length)] = message;
    }
    return live;
  }, [blueprint, variables, omitKeys, apiErrors]);

  const resourceErrors = useMemo(
    () => ({
      memoryMb: apiErrors['limits.memoryMb'],
      diskMb: apiErrors['limits.diskMb'],
      cpuCores: apiErrors['limits.cpuCores'],
    }),
    [apiErrors],
  );

  /** Why the operator cannot leave a step yet, or `null` when they can. */
  const blockerFor = useCallback(
    (key: StepKey): string | null => {
      switch (key) {
        case 'game':
          if (blueprintKey === null) return 'Pick a game to continue.';
          if (blueprintQuery.isPending) return 'Loading what this game can be configured with.';
          if (blueprintQuery.isError) return 'That game’s blueprint could not be loaded.';
          return null;
        case 'type':
          return selectedType === '' ? 'Pick a server type to continue.' : null;
        case 'details': {
          const problem = serverNameProblem(name);
          if (problem) return problem;
          if (!limits) return 'Waiting for this game’s memory and disk requirements.';
          /*
           * The sliders are clamped to what the node has left, so a request over capacity is
           * only reachable when even the blueprint's minimum does not fit. The API answers
           * that with a 507 — after four steps and a submission. Say it here instead.
           */
          if (capacity) {
            if (limits.memoryMb > capacity.memoryFreeMb) {
              return `${capacity.nodeName} has ${formatMegabytes(capacity.memoryFreeMb)} of memory free and this game needs at least ${formatMegabytes(limits.memoryMb)}. Free some by deleting a server, or lower another server’s limits.`;
            }
            if (limits.diskMb > capacity.diskFreeMb) {
              return `${capacity.nodeName} has ${formatMegabytes(capacity.diskFreeMb)} of disk free and this game needs at least ${formatMegabytes(limits.diskMb)}. Free some by deleting a server, or lower another server’s limits.`;
            }
          }
          return null;
        }
        case 'settings': {
          const outstanding = Object.keys(settingsErrors).length;
          return outstanding === 0
            ? null
            : `${outstanding} setting${outstanding === 1 ? ' still needs' : 's still need'} attention.`;
        }
        default:
          return null;
      }
    },
    [
      blueprintKey,
      blueprintQuery.isPending,
      blueprintQuery.isError,
      selectedType,
      name,
      limits,
      capacity,
      settingsErrors,
    ],
  );

  const isStepValid = useCallback(
    (index: number) => {
      const step = steps[index];
      return step ? blockerFor(step.key) === null : true;
    },
    [steps, blockerFor],
  );

  const currentStep = steps[stepIndex];
  const currentBlocker = currentStep ? blockerFor(currentStep.key) : null;
  const isLastStep = stepIndex === steps.length - 1;

  /*
   * On the last step the button has to answer for the whole form, not just this panel:
   * `submit()` refuses when *any* step is unhappy, and a Create button that looks live and
   * then does nothing is worse than one that says which step still needs something.
   */
  const submitBlocker = isLastStep
    ? (steps.map((step) => blockerFor(step.key)).find((problem) => problem !== null) ?? null)
    : currentBlocker;

  const create = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      blueprintKey: string;
      limits: ResourceValue;
      variables: VariableValues;
    }) =>
      api.post<Server>('/servers', {
        name: input.name,
        description: input.description,
        blueprintKey: input.blueprintKey,
        limits: input.limits,
        variables: input.variables,
        ports: {},
        autoStart: true,
        autoRestart: true,
        startOnCreate: true,
      }),
    onSuccess: (created) => {
      // Seed the cache so the server's own screen has its record before its first fetch, and
      // the sidebar shows the new row immediately.
      queryClient.setQueryData(queryKeys.servers.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });

      toast.create({
        title: `${created.name} is being created`,
        description:
          'Pulling the container image and running the install. Progress appears in the console.',
        type: 'info',
      });

      // Straight to the server: the console streams the install line by line, which is the
      // only honest picture of what is happening for the next few minutes.
      void navigate(`/servers/${created.id}`);
    },
    onError: (error: unknown) => {
      const fields = error instanceof ApiError ? error.fieldErrors : {};
      setApiErrors(fields);
      setFormError(errorMessage(error));

      // Land the operator on the step that owns the first complaint rather than making them
      // hunt for it.
      const firstKey = Object.keys(fields)[0];
      if (firstKey) {
        const owner: StepKey = firstKey.startsWith('variables.')
          ? firstKey === `variables.${TYPE_VARIABLE_KEY}` && showTypeStep
            ? 'type'
            : 'settings'
          : firstKey === 'blueprintKey'
            ? 'game'
            : 'details';
        const index = steps.findIndex((step) => step.key === owner);
        if (index >= 0) setStepIndex(index);
      }
    },
  });

  function submit() {
    if (!blueprintKey || !blueprint || !limits || !bounds) return;

    const problems = steps
      .map((step) => blockerFor(step.key))
      .filter((problem) => problem !== null);
    if (problems.length > 0) return;

    setFormError(null);
    // The submitted variables include the type even though its own picker owns the step.
    create.mutate({
      name: name.trim(),
      description: description.trim(),
      blueprintKey,
      limits: clampResources(limits, bounds),
      variables,
    });
  }

  function setVariable(key: string, value: string) {
    setVariables((current) => ({ ...current, [key]: value }));
    setApiErrors((current) => {
      if (!(`variables.${key}` in current)) return current;
      const next = { ...current };
      delete next[`variables.${key}`];
      return next;
    });
  }

  return (
    <>
      <PageHeader
        description="The game, resource limits and settings for a new server."
        eyebrow="Servers"
        title="New server"
      />

      <PageBody>
        <form
          className="flex flex-col gap-8"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (isLastStep) submit();
          }}
        >
          <Steps
            count={steps.length}
            isStepValid={isStepValid}
            linear
            onStepChange={({ step }) => setStepIndex(Math.min(step, steps.length - 1))}
            step={stepIndex}
          >
            {/*
              The full rail needs room for four labels. Below 640px it becomes one line of text,
              which is all a phone has space for and all the information the rail was carrying.
            */}
            <StepsList className="hidden sm:flex">
              {steps.map((step, index) => (
                <StepsItem index={index} key={step.key}>
                  <StepsTrigger className="min-h-11 pe-2">
                    <StepsIndicator>{index + 1}</StepsIndicator>
                    <StepsTitle className="text-subhead text-label">{step.title}</StepsTitle>
                  </StepsTrigger>
                  <StepsSeparator />
                </StepsItem>
              ))}
            </StepsList>

            <p
              aria-live="polite"
              className="text-subhead font-medium text-label-secondary sm:hidden"
              role="status"
            >
              {`Step ${stepIndex + 1} of ${steps.length} — ${currentStep?.title ?? ''}`}
            </p>

            {steps.map((step, index) => (
              <StepsContent className="pt-4" index={index} key={step.key}>
                <section className="flex flex-col gap-6">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-title-2 text-label">{step.title}</h2>
                    <p className="max-w-prose text-body text-balance text-label-secondary">
                      {step.blurb}
                    </p>
                  </div>

                  {step.key === 'game' ? (
                    <BlueprintPicker
                      onChange={(key) => {
                        setBlueprintKey(key);
                        setFormError(null);
                      }}
                      value={blueprintKey}
                    />
                  ) : null}

                  {step.key === 'type' && typeVariable ? (
                    <MinecraftTypePicker
                      onChange={(value) => setVariable(TYPE_VARIABLE_KEY, value)}
                      value={selectedType}
                      variable={typeVariable}
                    />
                  ) : null}

                  {step.key === 'details' ? (
                    <div className="flex flex-col gap-8">
                      <div className="flex max-w-md flex-col gap-6">
                        <Field invalid={Boolean(nameError ?? apiErrors.name)} required>
                          <FieldLabel>Server name</FieldLabel>
                          <Input
                            autoComplete="off"
                            className="h-11"
                            maxLength={LIMITS.serverNameMax}
                            name="name"
                            onBlur={() => setNameTouched(true)}
                            onChange={(event) => {
                              setName(event.target.value);
                              setNameTouched(true);
                            }}
                            value={name}
                          />
                          <FieldDescription>
                            What players and your collaborators see. You can rename it any time.
                          </FieldDescription>
                          <FieldError>{nameError ?? apiErrors.name}</FieldError>
                        </Field>

                        <Field invalid={Boolean(apiErrors.description)}>
                          <FieldLabel>Description</FieldLabel>
                          <Textarea
                            className="min-h-24"
                            maxLength={500}
                            name="description"
                            onChange={(event) => setDescription(event.target.value)}
                            value={description}
                          />
                          <FieldDescription>Optional. Not shown to players.</FieldDescription>
                          <FieldError>{apiErrors.description}</FieldError>
                        </Field>
                      </div>

                      {blueprint && limits ? (
                        <ResourceFields
                          blueprint={blueprint}
                          capacity={capacity}
                          errors={resourceErrors}
                          onChange={(next) =>
                            setLimits(bounds ? clampResources(next, bounds) : next)
                          }
                          value={limits}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {step.key === 'settings' && blueprint ? (
                    <VariableFields
                      errors={settingsErrors}
                      omitKeys={omitKeys}
                      onChange={setVariable}
                      promoteKeys={promoteKeys}
                      values={variables}
                      variables={blueprint.variables}
                    />
                  ) : null}
                </section>
              </StepsContent>
            ))}
          </Steps>

          {blueprintQuery.isError ? (
            <ErrorState
              error={blueprintQuery.error}
              onRetry={() => void blueprintQuery.refetch()}
              title="Couldn’t load that game"
              variant="inline"
            />
          ) : null}

          {formError ? (
            <p
              className="rounded-sm border border-danger/25 bg-danger-subtle px-3 py-2 text-subhead text-danger"
              role="alert"
            >
              {formError}
            </p>
          ) : null}

          {/* ---- Summary and navigation ---- */}
          <div className="flex flex-col gap-4 border-t border-separator pt-6">
            {blueprint && limits ? (
              <div className="flex flex-wrap items-center gap-3">
                <GameIcon
                  hue={blueprint.icon.hue}
                  monogram={blueprint.icon.monogram}
                  name={blueprint.name}
                  size="sm"
                />
                <p className="text-caption text-label-secondary">
                  <span className="font-medium text-label">{name.trim() || 'Unnamed server'}</span>
                  {` · ${blueprint.name}`}
                  {showTypeStep ? ` · ${minecraftTypeLabel(selectedType)}` : ''}
                  {` · ${formatMegabytes(limits.memoryMb)} memory · ${formatMegabytes(limits.diskMb)} disk`}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="h-11 rounded-button px-5 text-subhead font-medium"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
                size="lg"
                variant="ghost"
              >
                Back
              </Button>

              {isLastStep ? (
                <Button
                  {...(submitBlocker ? { 'aria-describedby': 'create-blocker' } : {})}
                  className="h-11 rounded-button px-5 text-subhead font-medium"
                  disabled={Boolean(submitBlocker) || !blueprint || !limits}
                  isLoading={create.isPending}
                  size="lg"
                  type="submit"
                >
                  Create server
                </Button>
              ) : (
                <Button
                  {...(currentBlocker ? { 'aria-describedby': 'create-blocker' } : {})}
                  className="h-11 rounded-button px-5 text-subhead font-medium"
                  disabled={Boolean(currentBlocker)}
                  onClick={() => setStepIndex((current) => Math.min(steps.length - 1, current + 1))}
                  size="lg"
                >
                  Next
                </Button>
              )}

              {submitBlocker ? (
                <span className="text-caption text-label-secondary" id="create-blocker">
                  {submitBlocker}
                </span>
              ) : null}
            </div>

            {isLastStep && !submitBlocker ? (
              <p className="max-w-prose text-caption text-label-tertiary">
                Creating it pulls the container image and runs the install, which takes a few
                minutes the first time. You will land on the console and see it happen.
              </p>
            ) : null}
          </div>
        </form>
      </PageBody>
    </>
  );
}
