import { useEffect, useMemo, useState } from 'react';
import type { CreateScheduleRequest, Schedule, ScheduleAction } from '@platter/shared';
import { formatRelativeTime } from '@platter/shared';
import { Calendar } from 'pixelarticons/react/Calendar.js';
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js';
import { Clock } from 'pixelarticons/react/Clock.js';
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js';
import { Play } from 'pixelarticons/react/Play.js';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { PageBody } from '@/components/layout/page-header';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRunScheduleNow,
  useSchedules,
  useToggleSchedule,
  useUpdateSchedule,
} from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { SECTION_HEADING, useServerScope } from './ServerLayout';
import { useAdvancedMode } from '@/lib/advanced-mode';
import { cn } from '@/lib/utils';

/**
 * Scheduled tasks.
 *
 * Nobody should have to read `0 4 * * *` in their head, so this screen never shows a raw cron
 * expression without also showing what it means and when it next fires. The presets are the
 * front door — a nightly restart and a daily backup cover almost everything anyone wants — and
 * the expression itself lives behind a disclosure for the people who came here to write one.
 *
 * The preview is computed in the schedule's own timezone and labelled with it, rather than
 * converted into the reader's local time. Converting would need a full IANA offset table to be
 * correct across a DST boundary, and a preview that is quietly an hour wrong twice a year is
 * worse than one that says plainly which clock it is using. The authoritative next run, once
 * the schedule exists, comes from the API and is shown beside it.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';
const FIELD = 'h-11';

// =======================================================================================
// Cron
// =======================================================================================

interface CronPlan {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  minuteWildcard: boolean;
  hourWildcard: boolean;
  domWildcard: boolean;
  monthWildcard: boolean;
  dowWildcard: boolean;
}

interface ParsedField {
  values: number[];
  wildcard: boolean;
  /** Step of a stepped expression, so a `slash-15` minute field reads as an interval. */
  step: number | null;
}

/**
 * One cron field.
 *
 * Handles the syntax the shared schema's regex allows and that a five-field cron actually
 * uses: `*`, `?`, lists, ranges and steps. Quartz's `L`, `W` and `#` are deliberately not
 * implemented — returning `null` for them is what makes the UI say "no preview" rather than
 * confidently draw the wrong times.
 */
function parseField(raw: string, min: number, max: number): ParsedField | null {
  const field = raw.trim();
  if (field === '') return null;
  if (/[LW#]/i.test(field)) return null;

  const values = new Set<number>();
  let wildcard = false;
  let step: number | null = null;

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined) return null;

    let interval = 1;
    if (stepPart !== undefined) {
      interval = Number(stepPart);
      if (!Number.isInteger(interval) || interval < 1) return null;
      step = interval;
    }

    let from: number;
    let to: number;
    if (rangePart === '*' || rangePart === '?') {
      from = min;
      to = max;
      if (stepPart === undefined) wildcard = true;
    } else if (rangePart.includes('-')) {
      const [low, high] = rangePart.split('-');
      from = Number(low);
      to = Number(high);
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < min || to > max || from > to) return null;

    for (let value = from; value <= to; value += interval) values.add(value);
  }

  if (values.size === 0) return null;
  return { values: [...values].sort((left, right) => left - right), wildcard, step };
}

export function parseCron(expression: string): CronPlan | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [rawMinute, rawHour, rawDom, rawMonth, rawDow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseField(rawMinute, 0, 59);
  const hour = parseField(rawHour, 0, 23);
  const dom = parseField(rawDom, 1, 31);
  const month = parseField(rawMonth, 1, 12);
  // Cron accepts both 0 and 7 for Sunday; normalise so the day list has no duplicate.
  const dow = parseField(rawDow, 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;

  const daysOfWeek = [...new Set(dow.values.map((day) => (day === 7 ? 0 : day)))].sort(
    (left, right) => left - right,
  );

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek,
    minuteWildcard: minute.wildcard,
    hourWildcard: hour.wildcard,
    domWildcard: dom.wildcard,
    monthWildcard: month.wildcard,
    dowWildcard: dow.wildcard,
  };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ordinal(value: number): string {
  const remainderTen = value % 10;
  const remainderHundred = value % 100;
  if (remainderTen === 1 && remainderHundred !== 11) return `${value}st`;
  if (remainderTen === 2 && remainderHundred !== 12) return `${value}nd`;
  if (remainderTen === 3 && remainderHundred !== 13) return `${value}rd`;
  return `${value}th`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Plain English for a five-field cron. Returns `null` when the expression cannot be read. */
export function describeCron(expression: string): string | null {
  const plan = parseCron(expression);
  if (!plan) return null;

  const fields = expression.trim().split(/\s+/);
  const minuteField = fields[0] ?? '';
  const hourField = fields[1] ?? '';

  // -- when in the day
  let time: string;
  if (plan.minuteWildcard && plan.hourWildcard) {
    time = 'Every minute';
  } else if (plan.minuteWildcard) {
    time = `Every minute of ${joinList(plan.hours.map((hour) => `${clock(hour, 0)}–${clock(hour, 59)}`))}`;
  } else if (minuteField.startsWith('*/') && plan.hourWildcard) {
    time = `Every ${minuteField.slice(2)} minutes`;
  } else if (plan.hourWildcard && plan.minutes.length === 1) {
    time = `At ${ordinal(plan.minutes[0] ?? 0)} minute past every hour`;
  } else if (hourField.startsWith('*/') && plan.minutes.length === 1) {
    time = `Every ${hourField.slice(2)} hours, at ${String(plan.minutes[0] ?? 0).padStart(2, '0')} minutes past`;
  } else {
    const times: string[] = [];
    for (const hour of plan.hours) {
      for (const minute of plan.minutes) times.push(clock(hour, minute));
      if (times.length > 6) break;
    }
    time =
      times.length > 6 ? `At ${times.slice(0, 6).join(', ')} and more` : `At ${joinList(times)}`;
  }

  // -- which days
  const dayParts: string[] = [];
  if (!plan.dowWildcard) {
    dayParts.push(`on ${joinList(plan.daysOfWeek.map((day) => DAY_NAMES[day] ?? String(day)))}`);
  }
  if (!plan.domWildcard) {
    dayParts.push(
      plan.daysOfMonth.length > 6
        ? `on ${plan.daysOfMonth.length} days of the month`
        : `on the ${joinList(plan.daysOfMonth.map(ordinal))}`,
    );
  }
  if (!plan.monthWildcard) {
    dayParts.push(
      `in ${joinList(plan.months.map((month) => MONTH_NAMES[month - 1] ?? String(month)))}`,
    );
  }

  const days = dayParts.length === 0 ? 'every day' : dayParts.join(', ');
  return `${time}, ${days}.`;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** "What time is it right now on that timezone's wall clock?" */
function wallClockNow(timeZone: string): WallClock | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);

    const value = {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      // `hour12: false` renders midnight as 24 in some engines.
      hour: read('hour') % 24,
      minute: read('minute'),
    };
    return Object.values(value).some(Number.isNaN) ? null : value;
  } catch {
    // An unknown timezone id. The API validates it properly; here it just means no preview.
    return null;
  }
}

/** How far ahead to look before giving up. A February-29th schedule can be nearly four years out. */
const PREVIEW_SEARCH_DAYS = 1500;

/**
 * The next few fire times, as wall-clock strings in the schedule's own timezone.
 *
 * The search walks days rather than minutes, and inside a matching day only the hours and
 * minutes the expression actually allows, so even `0 4 29 2 *` resolves in a few thousand
 * cheap iterations instead of two million.
 */
export function nextCronRuns(expression: string, timeZone: string, count = 3): Date[] {
  const plan = parseCron(expression);
  const now = wallClockNow(timeZone);
  if (!plan || !now) return [];

  // A UTC Date used purely as a carrier for wall-clock arithmetic: reading it back with the
  // `getUTC*` accessors gives exactly the fields that were put in, with no offset applied.
  const cursor = Date.UTC(now.year, now.month - 1, now.day);
  const nowValue = Date.UTC(now.year, now.month - 1, now.day, now.hour, now.minute);

  const results: Date[] = [];
  for (
    let dayOffset = 0;
    dayOffset < PREVIEW_SEARCH_DAYS && results.length < count;
    dayOffset += 1
  ) {
    const day = new Date(cursor + dayOffset * 86_400_000);
    const month = day.getUTCMonth() + 1;
    const dayOfMonth = day.getUTCDate();
    const dayOfWeek = day.getUTCDay();

    if (!plan.months.includes(month)) continue;
    /*
     * Cron's one genuine oddity: when both the day-of-month and the day-of-week fields are
     * restricted, a day matching *either* fires. Treating it as AND is the classic bug that
     * makes `0 0 1 * 1` silently never run.
     */
    const domMatch = plan.domWildcard || plan.daysOfMonth.includes(dayOfMonth);
    const dowMatch = plan.dowWildcard || plan.daysOfWeek.includes(dayOfWeek);
    const dayMatch =
      plan.domWildcard || plan.dowWildcard ? domMatch && dowMatch : domMatch || dowMatch;
    if (!dayMatch) continue;

    for (const hour of plan.hours) {
      for (const minute of plan.minutes) {
        const candidate = Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          dayOfMonth,
          hour,
          minute,
        );
        if (candidate <= nowValue) continue;
        results.push(new Date(candidate));
        if (results.length >= count) break;
      }
      if (results.length >= count) break;
    }
  }

  return results;
}

/** Formats a wall-clock carrier back into text without re-applying an offset. */
function formatWallClock(carrier: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(carrier);
}

// =======================================================================================
// Presets & vocabulary
// =======================================================================================

interface Preset {
  id: string;
  name: string;
  cron: string;
  action: ScheduleAction;
  payload: string | null;
  blurb: string;
}

const PRESETS: readonly Preset[] = [
  {
    id: 'nightly-restart',
    name: 'Nightly restart',
    cron: '0 4 * * *',
    action: 'restart',
    payload: null,
    blurb: 'Clears leaked memory and reloads config while nobody is on.',
  },
  {
    id: 'daily-backup',
    name: 'Daily backup',
    cron: '30 3 * * *',
    action: 'backup',
    payload: null,
    blurb: 'One archive a night, half an hour before the usual restart slot.',
  },
  {
    id: 'weekly-backup',
    name: 'Weekly backup',
    cron: '0 3 * * 0',
    action: 'backup',
    payload: null,
    blurb: 'Lighter on disk. Pair it with a lock on the ones you want to keep.',
  },
  {
    id: 'hourly-save',
    name: 'Hourly world save',
    cron: '0 * * * *',
    action: 'command',
    payload: 'save-all',
    blurb: 'Flushes chunks to disk, so a crash loses minutes rather than an hour.',
  },
];

const ACTION_LABELS: Record<ScheduleAction, string> = {
  start: 'Start the server',
  stop: 'Stop the server',
  restart: 'Restart the server',
  backup: 'Take a backup',
  command: 'Run a console command',
};

const LAST_RUN_TONE: Record<'success' | 'failed' | 'skipped', string> = {
  success: 'text-success',
  failed: 'text-danger',
  skipped: 'text-label-tertiary',
};

const LAST_RUN_LABEL: Record<'success' | 'failed' | 'skipped', string> = {
  success: 'Ran',
  failed: 'Failed',
  skipped: 'Skipped',
};

function timeZoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const supported = intl.supportedValuesOf?.('timeZone');
  if (supported && supported.length > 0) return supported;
  // Older engines: the browser's own zone plus UTC is enough to be useful.
  return [...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone])].filter(Boolean);
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// =======================================================================================

interface FormState {
  name: string;
  cron: string;
  timezone: string;
  action: ScheduleAction;
  payload: string;
  enabled: boolean;
  onlyWhenOnline: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    cron: '0 4 * * *',
    timezone: localTimeZone(),
    action: 'restart',
    payload: '',
    enabled: true,
    onlyWhenOnline: true,
  };
}

function formFrom(schedule: Schedule): FormState {
  return {
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    action: schedule.action,
    payload: schedule.payload ?? '',
    enabled: schedule.enabled,
    onlyWhenOnline: schedule.onlyWhenOnline,
  };
}

function formErrors(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.name.trim().length === 0) errors.name = 'Name it so you can tell two apart later.';
  if (form.cron.trim().split(/\s+/).length !== 5) {
    errors.cron = 'A cron expression has five fields: minute, hour, day, month, weekday.';
  } else if (!parseCron(form.cron)) {
    errors.cron = 'Platter cannot read that expression. Check each field is in range.';
  }
  if (form.action === 'command' && form.payload.trim().length === 0) {
    errors.payload = 'Enter the command to run.';
  }
  return errors;
}

function toRequest(form: FormState): CreateScheduleRequest {
  return {
    name: form.name.trim(),
    cron: form.cron.trim(),
    timezone: form.timezone,
    action: form.action,
    payload: form.action === 'command' ? form.payload.trim() : null,
    enabled: form.enabled,
    onlyWhenOnline: form.onlyWhenOnline,
  };
}

// =======================================================================================

export function SchedulesPage() {
  const { server } = useServerScope();

  const schedules = useSchedules(server.id);
  const create = useCreateSchedule(server.id);
  const update = useUpdateSchedule(server.id);
  const toggle = useToggleSchedule(server.id);
  const remove = useDeleteSchedule(server.id);
  const runNow = useRunScheduleNow(server.id);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  const rows = schedules.data?.data ?? [];
  const errors = formErrors(form);
  const valid = Object.keys(errors).length === 0;

  return (
    <PageBody className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className={SECTION_HEADING}>Schedules</h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Recurring tasks Platter runs for you — restarts, backups, or any console command. The
              clock runs on the Platter host, not inside the game.
            </p>
          </div>
          {!showForm ? (
            <Button
              className="h-11 rounded-button px-5 text-subhead font-medium"
              onClick={() => {
                setForm(emptyForm());
                setShowForm(true);
              }}
              size="lg"
            >
              <Calendar aria-hidden />
              New schedule
            </Button>
          ) : null}
        </div>

        {showForm ? (
          <form
            className="flex flex-col gap-6 rounded-md border border-separator-strong p-4 sm:p-6"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              create.mutate(toRequest(form), {
                onSuccess: (schedule) => {
                  setShowForm(false);
                  setForm(emptyForm());
                  toast.create({
                    title: `${schedule.name} scheduled`,
                    description: schedule.nextRunAt
                      ? `First run ${formatRelativeTime(schedule.nextRunAt)}.`
                      : 'It is saved but disabled, so it will not run yet.',
                    type: 'success',
                  });
                },
                onError: (cause: unknown) =>
                  toast.create({
                    title: 'Couldn’t save the schedule',
                    description: errorMessage(cause),
                    type: 'error',
                  }),
              });
            }}
          >
            <ScheduleFields errors={errors} onChange={setForm} showPresets value={form} />

            <div className="flex flex-wrap items-center gap-3">
              <Button
                {...(valid ? {} : { 'aria-describedby': 'schedule-create-hint' })}
                className="h-11 rounded-button px-5 text-subhead font-medium"
                disabled={!valid}
                isLoading={create.isPending}
                size="lg"
                type="submit"
              >
                Create schedule
              </Button>
              <Button
                className={ACTION}
                onClick={() => setShowForm(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              {!valid ? (
                <p className="text-caption text-label-tertiary" id="schedule-create-hint">
                  {Object.values(errors)[0]}
                </p>
              ) : null}
            </div>
          </form>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        {schedules.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 rounded-md" />
            <Skeleton className="h-24 rounded-md" />
            <span className="sr-only" role="status">
              Loading schedules.
            </span>
          </div>
        ) : null}

        {schedules.isError ? (
          <ErrorState
            error={schedules.error}
            onRetry={() => void schedules.refetch()}
            title="Couldn’t list the schedules"
            variant="inline"
          />
        ) : null}

        {schedules.isSuccess && rows.length === 0 && !showForm ? (
          <EmptyState
            action={{
              label: 'Add a nightly restart',
              onClick: () => {
                const preset = PRESETS[0];
                if (!preset) return;
                setForm({
                  ...emptyForm(),
                  name: preset.name,
                  cron: preset.cron,
                  action: preset.action,
                  payload: preset.payload ?? '',
                });
                setShowForm(true);
              },
            }}
            description="A nightly restart clears leaked memory before anyone notices, and a daily backup means a bad update costs a day rather than a world. Both take about ten seconds to set up."
            icon={<Clock />}
            size="sm"
            title="Nothing is scheduled"
          />
        ) : null}

        {rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-separator border-y border-separator">
            {rows.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                onDelete={() => setDeleting(schedule)}
                onEdit={() => setEditing(schedule)}
                onRunNow={() =>
                  runNow.mutate(schedule.id, {
                    onSuccess: () =>
                      toast.create({
                        title: `Running ${schedule.name} now`,
                        description: 'This does not move its next scheduled run.',
                        type: 'success',
                      }),
                    onError: (cause: unknown) =>
                      toast.create({
                        title: 'Couldn’t run it',
                        description: errorMessage(cause),
                        type: 'error',
                      }),
                  })
                }
                onToggle={(enabled) =>
                  toggle.mutate(
                    { scheduleId: schedule.id, enabled },
                    {
                      onError: (cause: unknown) =>
                        toast.create({
                          title: 'Couldn’t change it',
                          description: errorMessage(cause),
                          type: 'error',
                        }),
                    },
                  )
                }
                runPending={runNow.isPending && runNow.variables === schedule.id}
                schedule={schedule}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <EditDialog
        isPending={update.isPending}
        onClose={() => setEditing(null)}
        onSave={(next) => {
          if (!editing) return;
          update.mutate(
            { scheduleId: editing.id, patch: toRequest(next) },
            {
              onSuccess: () => {
                setEditing(null);
                toast.create({ title: `${next.name.trim()} updated`, type: 'success' });
              },
              onError: (cause: unknown) =>
                toast.create({
                  title: 'Couldn’t save the change',
                  description: errorMessage(cause),
                  type: 'error',
                }),
            },
          );
        }}
        schedule={editing}
      />

      <AlertDialog
        onOpenChange={({ open }) => (open ? undefined : setDeleting(null))}
        open={deleting !== null}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Delete {deleting?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? (describeCron(deleting.cron) ?? deleting.cron) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="text-subhead text-label-secondary">
            It stops running immediately. Backups it already took are kept — deleting a schedule
            never deletes what it produced.
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className={ACTION}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className={ACTION}
              isLoading={remove.isPending}
              onClick={() => {
                if (!deleting) return;
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    setDeleting(null);
                    toast.create({ title: `Deleted ${deleting.name}`, type: 'success' });
                  },
                  onError: (cause: unknown) =>
                    toast.create({
                      title: 'Couldn’t delete it',
                      description: errorMessage(cause),
                      type: 'error',
                    }),
                });
              }}
              variant="destructive"
            >
              Delete schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageBody>
  );
}

// =======================================================================================

function ScheduleFields({
  value,
  onChange,
  errors,
  showPresets = false,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
  errors: Record<string, string>;
  showPresets?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { advanced: advancedMode } = useAdvancedMode();
  const zones = useMemo(timeZoneOptions, []);
  // Global mode opens it; a cron error opens it whatever the mode, because an invalid
  // expression the user cannot see is a form they cannot submit and cannot debug.
  const advancedOpen = showAdvanced || advancedMode || Boolean(errors.cron);

  const activePreset = PRESETS.find(
    (preset) => preset.cron === value.cron.trim() && preset.action === value.action,
  );

  return (
    <FieldGroup className="gap-6">
      {showPresets ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-subhead font-medium text-label">Start from a preset</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PRESETS.map((preset) => {
              const selected = activePreset?.id === preset.id;
              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    'flex min-h-11 flex-col gap-1 rounded-md border p-3 text-start',
                    'transition-[background-color,border-color] duration-[var(--pl-duration-fast)]',
                    'motion-reduce:transition-none',
                    selected
                      ? 'border-accent bg-accent-subtle'
                      : 'border-separator-strong hover:bg-surface-hover',
                  )}
                  key={preset.id}
                  onClick={() =>
                    onChange({
                      ...value,
                      name: value.name.trim() === '' ? preset.name : value.name,
                      cron: preset.cron,
                      action: preset.action,
                      payload: preset.payload ?? '',
                    })
                  }
                  type="button"
                >
                  <span className="text-subhead font-medium text-label">{preset.name}</span>
                  <span className="text-caption text-label-secondary">{preset.blurb}</span>
                  <span className="text-caption text-label-tertiary">
                    {describeCron(preset.cron)}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <Field invalid={Boolean(errors.name)} required>
        <FieldLabel>Name</FieldLabel>
        <Input
          className={cn(FIELD, 'max-w-sm')}
          maxLength={64}
          name="scheduleName"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          placeholder="Nightly restart"
          value={value.name}
        />
        <FieldError>{errors.name}</FieldError>
      </Field>

      <Field>
        <FieldLabel>What it does</FieldLabel>
        <NativeSelect
          className="w-full max-w-sm [&>select]:h-11"
          onChange={(event) => onChange({ ...value, action: event.target.value as ScheduleAction })}
          size="lg"
          value={value.action}
        >
          {(Object.keys(ACTION_LABELS) as ScheduleAction[]).map((action) => (
            <NativeSelectOption key={action} value={action}>
              {ACTION_LABELS[action]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      {value.action === 'command' ? (
        <Field invalid={Boolean(errors.payload)} required>
          <FieldLabel>Command</FieldLabel>
          <Input
            className={cn(FIELD, 'max-w-sm font-mono')}
            maxLength={500}
            name="schedulePayload"
            onChange={(event) => onChange({ ...value, payload: event.target.value })}
            placeholder="save-all"
            value={value.payload}
          />
          <FieldHelper>
            Sent to the server’s console exactly as written, with no prefix.
          </FieldHelper>
          <FieldError>{errors.payload}</FieldError>
        </Field>
      ) : null}

      <CronPreview cron={value.cron} timezone={value.timezone} />

      {/*
        The raw expression is the advanced path, not the front door — but it is never hidden
        when it is the thing that is wrong.
      */}
      {!advancedOpen ? (
        <Button
          aria-expanded={false}
          className="h-11 w-fit rounded-button px-4 text-subhead font-medium text-label-secondary"
          onClick={() => setShowAdvanced(true)}
          type="button"
          variant="ghost"
        >
          <ChevronDown aria-hidden />
          Edit the timing myself
        </Button>
      ) : (
        <div className="flex flex-col gap-6 rounded-md border border-separator-strong p-4">
          <Field invalid={Boolean(errors.cron)} required>
            <FieldLabel>Cron expression</FieldLabel>
            <Input
              className={cn(FIELD, 'max-w-xs font-mono')}
              name="scheduleCron"
              onChange={(event) => onChange({ ...value, cron: event.target.value })}
              placeholder="0 4 * * *"
              spellCheck={false}
              value={value.cron}
            />
            <FieldHelper>
              Five fields: minute, hour, day of month, month, day of week. `0 4 * * *` is 04:00
              every day.
            </FieldHelper>
            <FieldError>{errors.cron}</FieldError>
          </Field>

          <Field>
            <FieldLabel>Timezone</FieldLabel>
            <NativeSelect
              className="w-full max-w-sm [&>select]:h-11"
              onChange={(event) => onChange({ ...value, timezone: event.target.value })}
              size="lg"
              value={value.timezone}
            >
              {zones.map((zone) => (
                <NativeSelectOption key={zone} value={zone}>
                  {zone}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldHelper>
              The clock the expression is read against. Daylight saving is handled by the API.
            </FieldHelper>
          </Field>

          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel>Skip when the server is offline</FieldLabel>
              <FieldHelper>
                {value.onlyWhenOnline
                  ? 'A run is skipped rather than waking a server you deliberately stopped.'
                  : 'The task runs even when the server is off — which is what you want for a start schedule.'}
              </FieldHelper>
            </div>
            <Switch
              checked={value.onlyWhenOnline}
              className="hit-target"
              onCheckedChange={({ checked }) =>
                onChange({ ...value, onlyWhenOnline: checked === true })
              }
            />
          </Field>

          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel>Enabled</FieldLabel>
              <FieldHelper>Turn it off to keep the schedule without it firing.</FieldHelper>
            </div>
            <Switch
              checked={value.enabled}
              className="hit-target"
              onCheckedChange={({ checked }) => onChange({ ...value, enabled: checked === true })}
            />
          </Field>
        </div>
      )}
    </FieldGroup>
  );
}

/** What the expression means, and when it actually fires. Always visible. */
function CronPreview({ cron, timezone }: { cron: string; timezone: string }) {
  const description = describeCron(cron);
  const runs = useMemo(() => nextCronRuns(cron, timezone, 3), [cron, timezone]);

  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-2 rounded-md bg-bg-sunken p-4"
      role="status"
    >
      <p className="text-subhead font-medium text-label">
        {description ?? 'Platter can’t preview that expression'}
      </p>
      {description === null ? (
        <p className="text-caption text-label-secondary">
          It may still be valid — the API understands a few extras this preview does not. Check the
          first run after you save.
        </p>
      ) : runs.length > 0 ? (
        <>
          <p className="text-caption text-label-tertiary">Next runs, {timezone} time</p>
          <ul className="tabular flex flex-col gap-0.5 font-mono text-caption text-label-secondary">
            {runs.map((run) => (
              <li key={run.toISOString()}>{formatWallClock(run)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-caption text-label-secondary">
          Nothing matches in the next four years. Check the day and month fields agree with each
          other.
        </p>
      )}
    </div>
  );
}

// =======================================================================================

function ScheduleRow({
  schedule,
  runPending,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  runPending: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const description = describeCron(schedule.cron);

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-subhead font-medium text-label">{schedule.name}</span>
          <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
            {ACTION_LABELS[schedule.action]}
          </span>
          {!schedule.enabled ? (
            <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-tertiary">
              Paused
            </span>
          ) : null}
        </div>

        <p className="text-caption text-label-secondary">
          {description ?? <code className="font-mono">{schedule.cron}</code>}
          {schedule.action === 'command' && schedule.payload ? (
            <>
              {' '}
              Runs <code className="font-mono text-label">{schedule.payload}</code>.
            </>
          ) : null}
        </p>

        <p className="tabular flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-caption text-label-tertiary">
          <code>{schedule.cron}</code>
          <span aria-hidden>·</span>
          <span>{schedule.timezone}</span>
          {schedule.enabled && schedule.nextRunAt ? (
            <>
              <span aria-hidden>·</span>
              <span>
                next {formatRelativeTime(schedule.nextRunAt)}
                <span className="sr-only"> ({new Date(schedule.nextRunAt).toLocaleString()})</span>
              </span>
            </>
          ) : null}
          {schedule.lastRunAt && schedule.lastRunStatus ? (
            <>
              <span aria-hidden>·</span>
              <span className={LAST_RUN_TONE[schedule.lastRunStatus]}>
                {LAST_RUN_LABEL[schedule.lastRunStatus].toLowerCase()}{' '}
                {formatRelativeTime(schedule.lastRunAt)}
              </span>
            </>
          ) : null}
        </p>

        {schedule.lastRunStatus === 'failed' && schedule.lastRunError ? (
          <p className="max-w-prose text-caption text-danger">{schedule.lastRunError}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={`${schedule.enabled ? 'Pause' : 'Resume'} ${schedule.name}`}
            checked={schedule.enabled}
            className="hit-target"
            onCheckedChange={({ checked }) => onToggle(checked === true)}
          />
          <span aria-hidden className="text-caption text-label-tertiary">
            {schedule.enabled ? 'On' : 'Off'}
          </span>
        </div>

        <Menu>
          <MenuTrigger asChild>
            <Button
              aria-label={`Actions for ${schedule.name}`}
              className="hit-target size-11 text-label-tertiary hover:text-label"
              size="icon-lg"
              variant="ghost"
            >
              <MoreVertical aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent className="w-56">
            <MenuItem disabled={runPending} onClick={onRunNow} value="run">
              <Play aria-hidden />
              {runPending ? 'Starting…' : 'Run it now'}
            </MenuItem>
            <MenuItem onClick={onEdit} value="edit">
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={onDelete} value="delete" variant="destructive">
              Delete schedule
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

// =======================================================================================

function EditDialog({
  schedule,
  isPending,
  onClose,
  onSave,
}: {
  schedule: Schedule | null;
  isPending: boolean;
  onClose: () => void;
  onSave: (form: FormState) => void;
}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  useEffect(() => {
    if (schedule) setForm(formFrom(schedule));
  }, [schedule]);

  const errors = formErrors(form);
  const valid = Object.keys(errors).length === 0;

  return (
    <Dialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={schedule !== null}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="font-sans text-title-3 font-semibold">
            Edit {schedule?.name}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="edit-schedule-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) onSave(form);
            }}
          >
            <ScheduleFields errors={errors} onChange={setForm} value={form} />
          </form>
        </DialogBody>
        <DialogFooter>
          <Button className={ACTION} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            className={ACTION}
            disabled={!valid}
            form="edit-schedule-form"
            isLoading={isPending}
            type="submit"
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
