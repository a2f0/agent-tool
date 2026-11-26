/**
 * Pure analysis behind `agent-tool ci timings`: which jobs hold a workflow's
 * wall clock across recent runs, where one run's jobs spend their steps, and
 * which tasks and test files a job log executed.
 */

export interface TimedStep { name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null }
export interface TimedJob { id: number; name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; steps?: TimedStep[] }
export interface TimedRun { id: number; event: string; attempt: number; createdAt: string; jobs: TimedJob[] }

const minutesBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;
const round = (value: number, places = 1) => Number(value.toFixed(places));

/** The nearest-rank value at fraction `q` of `values`; 0 when there are none. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** A job's lane: its name without shard counters such as `2/3`, so a split suite's shards count as one. */
export function lane(name: string): string {
  return name.replace(/\s*\b\d+\/\d+\b\s*/g, " ").replace(/\(\s*\)/g, "").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();
}

/** Jobs that ran in this attempt: skipped jobs and jobs without both timestamps are left out. */
export function executedJobs(jobs: TimedJob[]): (TimedJob & { startedAt: string; completedAt: string })[] {
  return jobs.filter((job): job is TimedJob & { startedAt: string; completedAt: string } =>
    job.conclusion !== "skipped" && !!job.startedAt && !!job.completedAt && Date.parse(job.completedAt) >= Date.parse(job.startedAt));
}

export interface Spread { median: number; p90: number; min: number; max: number }
const spread = (values: number[], places = 1): Spread =>
  ({ median: round(quantile(values, 0.5), places), p90: round(quantile(values, 0.9), places), min: round(values.length ? Math.min(...values) : 0, places), max: round(values.length ? Math.max(...values) : 0, places) });

export interface JobStats {
  name: string;
  lane: string;
  runs: number;
  minutes: Spread;
  /** Share of runs in which the job took at least the threshold: how often it did real work rather than replay a cache. */
  overThresholdShare: number;
  /** Seconds from the run's creation to the job's start; a steady lag is a `needs` chain, a spiky p90 is queueing. */
  startLagSeconds: Spread;
}

export interface TimingSummary {
  runs: number;
  /** Runs left out: re-run attempts mix timestamps of several attempts, and runs without the named gate job. */
  excluded: { reruns: number; missingGate: number };
  thresholdMinutes: number;
  /** Run creation to the gate job's end, or to the last job's end without a gate. */
  wallMinutes: Spread;
  /** Run creation to its first job's start: time spent waiting for any runner. */
  firstStartLagSeconds: Spread;
  /** How often each lane finished last among the jobs the gate waits for, which is what holds the wall clock. */
  lastToFinish: { lane: string; runs: number }[];
  jobs: JobStats[];
}

/** Summarize successful runs of one workflow. A gate job, when named, ends the wall clock and is left out of `lastToFinish`. */
export function summarizeRuns(runs: TimedRun[], options: { gate?: string; thresholdMinutes: number }): TimingSummary {
  const excluded = { reruns: 0, missingGate: 0 };
  const walls: number[] = [], firstLags: number[] = [];
  const last = new Map<string, number>();
  const perJob = new Map<string, { durations: number[]; lags: number[] }>();
  for (const run of runs) {
    if (run.attempt > 1) { excluded.reruns++; continue; }
    const jobs = executedJobs(run.jobs);
    if (!jobs.length) continue;
    const gate = options.gate === undefined ? undefined : jobs.find(job => job.name === options.gate);
    if (options.gate !== undefined && !gate) { excluded.missingGate++; continue; }
    const work = jobs.filter(job => job !== gate);
    const end = gate?.completedAt ?? work.reduce((latest, job) => job.completedAt > latest ? job.completedAt : latest, work[0]!.completedAt);
    walls.push(minutesBetween(run.createdAt, end));
    firstLags.push(Math.max(0, minutesBetween(run.createdAt, jobs.reduce((first, job) => job.startedAt < first ? job.startedAt : first, jobs[0]!.startedAt)) * 60));
    const finisher = work.reduce<(typeof work)[number] | undefined>((latest, job) => !latest || job.completedAt > latest.completedAt ? job : latest, undefined);
    if (finisher) last.set(lane(finisher.name), (last.get(lane(finisher.name)) ?? 0) + 1);
    for (const job of work) {
      const entry = perJob.get(job.name) ?? { durations: [], lags: [] };
      entry.durations.push(minutesBetween(job.startedAt, job.completedAt));
      entry.lags.push(Math.max(0, minutesBetween(run.createdAt, job.startedAt) * 60));
      perJob.set(job.name, entry);
    }
  }
  const jobs = [...perJob].map(([name, { durations, lags }]): JobStats => ({
    name,
    lane: lane(name),
    runs: durations.length,
    minutes: spread(durations),
    overThresholdShare: round(durations.filter(value => value >= options.thresholdMinutes).length / durations.length, 2),
    startLagSeconds: spread(lags, 0),
  })).sort((a, b) => b.minutes.median - a.minutes.median || a.name.localeCompare(b.name));
  return {
    runs: walls.length,
    excluded,
    thresholdMinutes: options.thresholdMinutes,
    wallMinutes: spread(walls),
    firstStartLagSeconds: spread(firstLags, 0),
    lastToFinish: [...last].map(([name, count]) => ({ lane: name, runs: count })).sort((a, b) => b.runs - a.runs || a.lane.localeCompare(b.lane)),
    jobs,
  };
}

export interface JobSteps { id: number; name: string; minutes: number; startOffsetMinutes: number; steps: { name: string; seconds: number }[] }

/** One run's executed jobs, longest first, each with the steps that took at least `minSeconds`. */
export function runSteps(createdAt: string, jobs: TimedJob[], minSeconds: number): JobSteps[] {
  return executedJobs(jobs).map(job => ({
    id: job.id,
    name: job.name,
    minutes: round(minutesBetween(job.startedAt, job.completedAt)),
    startOffsetMinutes: round(Math.max(0, minutesBetween(createdAt, job.startedAt))),
    steps: (job.steps ?? []).filter(step => step.startedAt && step.completedAt)
      .map(step => ({ name: step.name, seconds: round(minutesBetween(step.startedAt!, step.completedAt!) * 60, 0) }))
      .filter(step => step.seconds >= minSeconds),
  })).sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
}

export interface LogTask { task: string; cache: "hit" | "miss" | "bypass" }
export interface LogFile { task: string | null; file: string; seconds: number; cases: number; cached: boolean }
export interface LogTimings { tasks: LogTask[]; files: LogFile[]; casesWithoutDuration: number }

// GitHub prefixes every log line with an ISO timestamp; Turbo and Bun color their output.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CASE = /^\((pass|fail|skip|todo)\)\s/;
const DURATION = /\[(\d+(?:\.\d+)?)(ms|s)\]\s*$/;
const CACHE = /^cache (hit|miss|bypass)\b/;

/**
 * Read a GitHub Actions job log: each Turbo task's cache result (`##[group]<task>` followed by
 * `cache hit`, `cache miss`, or `cache bypass`), and each Bun test file's summed case durations
 * (`##[group]<file>:` followed by `(pass) name [12.34ms]` lines). Files a replayed (cached)
 * task printed are marked `cached`: their durations come from the run that filled the cache.
 */
export function parseJobLog(text: string): LogTimings {
  const lines = text.split(/\r?\n/).map(line => line.replace(TIMESTAMP, "").replace(ANSI, ""));
  const tasks: LogTask[] = [];
  const files = new Map<string, LogFile>();
  const stack: { kind: "task" | "file" | "other"; name: string; cached: boolean }[] = [];
  let casesWithoutDuration = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("##[group]")) {
      const name = line.slice("##[group]".length).trim();
      const next = lines.slice(index + 1).find(candidate => candidate.trim() !== "")?.trim() ?? "";
      const cache = next.match(CACHE)?.[1] as LogTask["cache"] | undefined;
      const parent = [...stack].reverse().find(entry => entry.kind === "task");
      if (cache) { tasks.push({ task: name, cache }); stack.push({ kind: "task", name, cached: cache === "hit" }); }
      else if (name.endsWith(":")) stack.push({ kind: "file", name: name.slice(0, -1), cached: parent?.cached ?? false });
      else stack.push({ kind: "other", name, cached: parent?.cached ?? false });
      continue;
    }
    if (line.startsWith("##[endgroup]")) { stack.pop(); continue; }
    const trimmed = line.trim();
    if (!CASE.test(trimmed)) continue;
    const top = stack.at(-1);
    if (top?.kind !== "file") continue;
    const duration = trimmed.match(DURATION);
    const task = [...stack].reverse().find(entry => entry.kind === "task")?.name ?? null;
    const key = `${task ?? ""}\u0000${top.name}`;
    const entry = files.get(key) ?? { task, file: top.name, seconds: 0, cases: 0, cached: top.cached };
    entry.cases++;
    if (duration) entry.seconds += Number(duration[1]) / (duration[2] === "ms" ? 1000 : 1);
    else if (!trimmed.startsWith("(skip)") && !trimmed.startsWith("(todo)")) casesWithoutDuration++;
    files.set(key, entry);
  }
  return {
    tasks,
    files: [...files.values()].map(file => ({ ...file, seconds: round(file.seconds) })).sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file)),
    casesWithoutDuration,
  };
}
