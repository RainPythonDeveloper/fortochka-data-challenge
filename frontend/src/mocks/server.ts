// In-memory stand-in for the backend. Reloading the page resets it.
import type { Api } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type {
  Appeal,
  ChecklistVersion,
  ConversationDetail,
  ConversationSummary,
  CriterionResult,
  EvaluationCompare,
  EvaluationRun,
  EvaluationSummary,
  ExportItem,
  Job,
  JobStage,
  ModelAttempt,
  ReportBucket,
  ReviewStatus,
  ScoreSummary,
  StageId,
} from '../api/types.ts';
import { chatChecklist, voiceChecklist } from './checklists.ts';
import { importableConversations, seedConversations } from './conversations.ts';
import { blockedConversations, failingConversations, seedOpenAppeals, seedRuns, seedStubConversations } from './results.ts';
import { calculateScore } from './scoring.ts';

const clone = <T>(value: T): T => structuredClone(value);
const wait = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeHash = (seed: string) =>
  Array.from({ length: 4 }, (_, part) => {
    let hash = 2166136261 + part;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, '0')}`;
// Seeded runs are spread over the last hour; everything after them happens now.
let seedClock: number | null = Date.now() - 62 * 60_000;
const now = () => {
  if (seedClock === null) return new Date().toISOString();
  seedClock += 4.5 * 60_000;
  return new Date(seedClock).toISOString();
};

const conversations: ConversationDetail[] = clone(seedConversations);
const importPool: ConversationDetail[] = clone(importableConversations);
const checklists = new Map<string, ChecklistVersion[]>([
  [chatChecklist.checklist_id, [clone(chatChecklist)]],
  [voiceChecklist.checklist_id, [clone(voiceChecklist)]],
]);
const runs: EvaluationRun[] = [];
const appeals: Appeal[] = [];
const jobs = new Map<string, Job>();

const latestOf = (checklistId: string) => {
  const versions = checklists.get(checklistId);
  if (!versions) throw new ApiError(404, 'Оценочный лист не найден');
  return versions[versions.length - 1];
};

const findConversation = (id: string) => {
  const found = conversations.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'Диалог не найден');
  return found;
};

const findRun = (id: string) => {
  const found = runs.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'Оценка не найдена');
  return found;
};

function attempts(stub: boolean, invalid?: string): ModelAttempt[] {
  const base = { role: 'primary', attempt: 1, cost_usd: 0.0031, input_tokens: 2140, output_tokens: 610, latency_ms: 64_000 };
  if (stub) {
    return [{ provider: 'mock', model: 'mock', role: 'primary', attempt: 1, latency_ms: null, input_tokens: null, output_tokens: null, cost_usd: null, valid: true, errors: [] }];
  }
  const first: ModelAttempt = { ...base, provider: 'demo-provider', model: 'demo-model', valid: !invalid, errors: invalid ? [invalid] : [] };
  return invalid ? [first, { ...first, attempt: 2 }] : [first];
}

const emptyScore: ScoreSummary = {
  total: null, partial_total: null, is_partial: false, missing_criteria: [],
  gross_error: false, gross_error_criteria: [], criteria: [], sections: [],
};

const rubricHash = (checklist: ChecklistVersion) =>
  fakeHash(JSON.stringify([checklist.sections, checklist.criteria.map((item) => ({ ...item, weight: 0 }))]));

function buildRun(
  conversation: ConversationDetail,
  checklist: ChecklistVersion | null,
  results: CriterionResult[],
  options: {
    stub?: boolean;
    failed?: boolean;
    invalid?: string;
    review_status?: ReviewStatus;
    review_reasons?: string[];
    /** Measured time of a run made during the session. */
    stages?: { id: StageId; ms: number }[];
    cachedFrom?: string;
  } = {},
): EvaluationRun {
  const id = nextId('eval');
  const score = checklist ? calculateScore(checklist, results) : clone(emptyScore);
  const attemptList = options.cachedFrom ? [] : attempts(Boolean(options.stub), options.invalid);
  const modelMs = attemptList.reduce((sum, item) => sum + (item.latency_ms ?? 0), 0);
  const stages = options.stages ?? [
    { id: 'parse' as const, ms: 210 },
    { id: 'model' as const, ms: modelMs },
    { id: 'validate' as const, ms: 95 },
    { id: 'score' as const, ms: 9 },
  ];
  const cost = attemptList.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0);
  const run: EvaluationRun = {
    id,
    conversation_id: conversation.id,
    checklist_id: checklist?.checklist_id ?? '',
    checklist_version: checklist?.version ?? 0,
    status: options.failed ? 'failed' : 'done',
    total: score.total,
    final_total: score.total,
    gross_error: score.gross_error,
    created_at: now(),
    error: options.failed ? (options.invalid ?? 'Оценка не выполнена') : null,
    results,
    score,
    final_results: clone(results),
    final_score: clone(score),
    checklist: clone(checklist),
    review_status: options.stub || options.failed ? 'flagged' : (options.review_status ?? 'clear'),
    review_reasons: options.failed
      ? [...(options.review_reasons ?? []), 'evaluation_failed']
      : options.stub
        ? ['mock_provider']
        : (options.review_reasons ?? []),
    log: {
      run_id: id,
      content_hash: fakeHash(conversation.id),
      checklist_hash: checklist ? rubricHash(checklist) : '',
      prompt_hash: options.stub ? '' : fakeHash('prompt'),
      pipeline: 'single',
      attempts: attemptList,
      cache_hit: Boolean(options.cachedFrom),
      latency_ms: options.cachedFrom ? null : Math.round(stages.reduce((sum, item) => sum + item.ms, 0)),
      cost_usd: cost > 0 ? Number(cost.toFixed(4)) : null,
      cached_from: options.cachedFrom ?? null,
      stages: options.failed ? stages.slice(0, 1) : stages,
      evaluator: options.stub ? { provider: 'mock', model: 'mock', pipeline: 'single' } : { provider: 'demo-provider', model: 'demo-model', pipeline: 'single' },
    },
  };
  runs.push(run);
  syncConversation(run);
  return run;
}

function syncConversation(run: EvaluationRun) {
  const conversation = findConversation(run.conversation_id);
  conversation.latest_evaluation_id = run.id;
  conversation.latest_total = run.final_total;
  conversation.gross_error = run.final_score.gross_error;
}

// Stub evaluator. Like the mock provider in cqa_ai it calls no model; it keeps the
// previous answer when it still fits, so a new checklist version gives a stable demo.
function stubResults(conversation: ConversationDetail, checklist: ChecklistVersion): CriterionResult[] {
  const previous = [...runs].reverse().find((run) => run.conversation_id === conversation.id && run.status === 'done');
  const firstOperator = conversation.turns.find((turn) => turn.speaker === 'operator');
  const evidence = firstOperator ? [{ turn_index: firstOperator.index, quote: firstOperator.text }] : [];
  return checklist.criteria.map((criterion) => {
    const old = previous?.results.find((item) => item.criterion_id === criterion.id);
    const values = criterion.levels.map((level) => level.value);
    const fits =
      old &&
      ((old.status === 'not_applicable' && criterion.allow_na) ||
        (old.status === 'assessed' &&
          (criterion.type === 'boolean' ? typeof old.answer === 'string' : values.includes(old.answer as number))));
    if (fits) return { ...clone(old), review_flags: [...old.review_flags.filter((flag) => flag !== 'mock_provider'), 'mock_provider'] };
    return {
      criterion_id: criterion.id,
      status: 'assessed',
      answer: criterion.type === 'scale' ? Math.max(...values) : criterion.flag ? 'no' : 'yes',
      justification: 'Синтетические данные: модель не вызывалась.',
      evidence,
      reviewed_range: null,
      expected_at_turn: null,
      review_flags: ['mock_provider'],
    };
  });
}

const BLOCKED_REASON = 'Звонок не отправлен в модель: в нём есть персональные данные.';

for (const id of blockedConversations) {
  buildRun(findConversation(id), voiceChecklist, [], {
    failed: true, invalid: BLOCKED_REASON, review_reasons: ['personal_data_not_sent'],
  });
}
for (const id of failingConversations) {
  buildRun(findConversation(id), chatChecklist, [], { failed: true, invalid: 'Провайдер не ответил за отведённое время' });
}
for (const id of seedStubConversations) {
  const conversation = findConversation(id);
  buildRun(conversation, chatChecklist, stubResults(conversation, chatChecklist), { stub: true });
}
// Oldest first, so the dialogue of the design reference ends up on top.
for (const seed of [...seedRuns].reverse()) {
  buildRun(findConversation(seed.conversation_id), seed.checklist === 'chat' ? chatChecklist : voiceChecklist, clone(seed.results), {
    invalid: seed.invalid_attempt,
    review_status: seed.review_status,
    review_reasons: seed.review_reasons,
  });
}
for (const seed of seedOpenAppeals) {
  appeals.push({
    id: nextId('appeal'),
    evaluation_id: findConversation(seed.conversation_id).latest_evaluation_id as string,
    criterion_id: seed.criterion_id,
    comment: seed.comment,
    status: 'open',
    created_at: now(),
    decision: null,
  });
}
seedClock = null;

function toSummary({ turns: _turns, ...summary }: ConversationDetail): ConversationSummary {
  const run = runs.find((item) => item.id === summary.latest_evaluation_id);
  const own = new Set(runs.filter((item) => item.conversation_id === summary.id).map((item) => item.id));
  return clone({
    ...summary,
    latest_status: run?.status ?? null,
    latest_error: run?.error ?? null,
    latest_reasons: run?.review_reasons ?? [],
    latest_evaluated_at: run?.created_at ?? null,
    review_status: run?.review_status ?? null,
    open_appeals: appeals.filter((item) => item.status === 'open' && own.has(item.evaluation_id)).length,
  });
}

const toEvaluationSummary = (run: EvaluationRun): EvaluationSummary => ({
  id: run.id,
  conversation_id: run.conversation_id,
  checklist_id: run.checklist_id,
  checklist_version: run.checklist_version,
  status: run.status,
  total: run.total,
  final_total: run.final_total,
  gross_error: run.gross_error,
  created_at: run.created_at,
  error: run.error,
});

function applyDecisions(run: EvaluationRun) {
  const results = clone(run.results);
  for (const appeal of appeals) {
    const decision = appeal.decision;
    if (appeal.evaluation_id !== run.id || decision?.decision !== 'change') continue;
    const target = results.find((item) => item.criterion_id === appeal.criterion_id);
    if (!target) continue;
    target.status = decision.new_status ?? 'assessed';
    target.answer = target.status === 'assessed' ? (decision.new_answer ?? null) : null;
    target.justification = `Решение проверяющего: ${decision.reason}`;
  }
  run.final_results = results;
  if (run.checklist) run.final_score = calculateScore(run.checklist, results);
  run.final_total = run.final_score.total;
  run.gross_error = run.final_score.gross_error;
  if (conversations.find((item) => item.id === run.conversation_id)?.latest_evaluation_id === run.id) {
    syncConversation(run);
  }
}

const standardIds = [chatChecklist.checklist_id, voiceChecklist.checklist_id];

// Same order as the backend: an explicit choice, then the standard checklist, then the
// only match. Several custom matches are an error the user has to resolve.
function byChannel(channel: string, assigned: Record<string, string>): ChecklistVersion | null {
  if (assigned[channel]) return latestOf(assigned[channel]);
  const matches = [...checklists.keys()].map(latestOf).filter((item) => item.channels.includes(channel));
  const standard = matches.find((item) => standardIds.includes(item.checklist_id));
  if (standard || matches.length <= 1) return standard ?? matches[0] ?? null;
  throw new ApiError(422, `Для канала '${channel}' подходит несколько листов: ${matches.map((item) => item.checklist_id).join(', ')}`);
}

const STAGE_MS: Record<StageId, number> = { parse: 500, model: 3200, validate: 500, score: 200 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluateOne(job: Job, id: string, chosen: ChecklistVersion | null, assigned: Record<string, string>, force: boolean) {
  const current: JobStage = { conversation_id: id, stage: 'parse', started_at: new Date().toISOString() };
  job.current = [current];
  const conversation = findConversation(id);
  const checklist = chosen ?? byChannel(conversation.channel, assigned);
  const stages: { id: StageId; ms: number }[] = [];
  const stage = async (next: StageId) => {
    current.stage = next;
    current.started_at = new Date().toISOString();
    await pause(STAGE_MS[next]);
    stages.push({ id: next, ms: STAGE_MS[next] });
  };
  await stage('parse');

  const fail = (message: string, reasons?: string[]) => {
    const failed = buildRun(conversation, checklist, [], { failed: true, invalid: message, review_reasons: reasons, stages });
    job.failed += 1;
    job.errors.push(`${conversation.id}: ${message}`);
    job.evaluation_ids.push(failed.id);
  };
  if (!checklist) return fail(`Нет оценочного листа для канала '${conversation.channel}'`);
  const cached = runs.find(
    (run) =>
      run.conversation_id === conversation.id &&
      run.status === 'done' &&
      run.checklist_id === checklist.checklist_id &&
      run.log.checklist_hash === rubricHash(checklist),
  );
  if (cached && !force) {
    await stage('score');
    const run = buildRun(conversation, checklist, clone(cached.results), { cachedFrom: cached.id, stages, review_status: cached.review_status, review_reasons: cached.review_reasons });
    job.done += 1;
    job.evaluation_ids.push(run.id);
    return;
  }
  await stage('model');
  if (blockedConversations.includes(conversation.id)) return fail(BLOCKED_REASON, ['personal_data_not_sent']);
  if (failingConversations.includes(conversation.id)) return fail('Провайдер не ответил за отведённое время');
  await stage('validate');
  await stage('score');
  const run = buildRun(conversation, checklist, stubResults(conversation, checklist), { stub: true, stages });
  job.done += 1;
  job.evaluation_ids.push(run.id);
}

async function runJob(job: Job, ids: string[], chosen: ChecklistVersion | null, assigned: Record<string, string>, force: boolean) {
  job.status = 'running';
  for (const id of ids) await evaluateOne(job, id, chosen, assigned, force);
  job.current = [];
  job.status = job.failed === job.total ? 'failed' : 'done';
}

export const mockApi: Api = {
  async importGroup(groupId) {
    await wait(500);
    const added = importPool.splice(0);
    conversations.push(...added);
    return {
      group_id: groupId,
      imported: added.length,
      skipped: added.length ? 0 : conversations.length,
      conversation_ids: added.map((item) => item.id),
      errors: added.length ? [`warning: запрошена группа ${groupId}, получена MOCK`] : [],
    };
  },
  async listConversations(filters = {}) {
    await wait();
    return conversations
      .filter((item) => (!filters.channel || item.channel === filters.channel) && (!filters.language || item.language === filters.language))
      .map(toSummary);
  },
  async getConversation(id) {
    await wait();
    return clone(findConversation(id));
  },
  audioUrl: () => null,
  async uploadTranscript(input) {
    await wait();
    const record = input as { conversation_id?: unknown; channel?: unknown; language?: unknown; transcript?: unknown };
    if (typeof record?.conversation_id !== 'string' || !Array.isArray(record.transcript) || !record.transcript.length) {
      throw new ApiError(422, 'поле transcript отсутствует или пусто');
    }
    const lines = record.transcript as { timestamp?: unknown; speaker?: unknown; text?: unknown }[];
    const conversation: ConversationDetail = {
      id: record.conversation_id,
      channel: String(record.channel ?? 'agent chat'),
      language: String(record.language ?? 'RU'),
      turn_count: lines.length,
      has_audio: false,
      group_id: null,
      latest_evaluation_id: null,
      latest_total: null,
      gross_error: false,
      turns: lines.map((line, index) => ({ index, timestamp: String(line.timestamp ?? ''), speaker: String(line.speaker ?? ''), text: String(line.text ?? '') })),
    };
    if (conversations.some((item) => item.id === conversation.id)) conversation.id = `${conversation.id}-${nextId('copy')}`;
    conversations.push(conversation);
    return { ...toSummary(conversation), warnings: [] };
  },
  async listChecklists() {
    await wait();
    return [...checklists.keys()].map((id) => {
      const latest = latestOf(id);
      return { checklist_id: id, title: latest.title, latest_version: latest.version, channels: latest.channels };
    });
  },
  async getChecklist(id, version) {
    await wait();
    const found = version ? checklists.get(id)?.find((item) => item.version === version) : latestOf(id);
    if (!found) throw new ApiError(404, 'Версия листа не найдена');
    return clone(found);
  },
  async createChecklist(checklist) {
    await wait(300);
    if (checklists.has(checklist.checklist_id)) throw new ApiError(409, 'Лист с таким идентификатором уже есть');
    const saved = { ...clone(checklist), version: 1 };
    checklists.set(saved.checklist_id, [saved]);
    return clone(saved);
  },
  async createChecklistVersion(checklist) {
    await wait(300);
    const saved = { ...clone(checklist), version: latestOf(checklist.checklist_id).version + 1 };
    checklists.get(checklist.checklist_id)?.push(saved);
    return clone(saved);
  },
  async createEvaluation(request) {
    await wait();
    if (!request.conversation_ids.length) throw new ApiError(422, 'Не выбраны диалоги');
    if (request.version && !request.checklist_id) throw new ApiError(422, 'Поле version требует checklist_id');
    if (request.checklist_id && request.checklists_by_channel) {
      throw new ApiError(422, 'Укажите либо checklist_id, либо checklists_by_channel');
    }
    const assigned = request.checklists_by_channel ?? {};
    if (!request.checklist_id) {
      for (const id of request.conversation_ids) byChannel(findConversation(id).channel, assigned);
    }
    const versions = request.checklist_id ? checklists.get(request.checklist_id) : null;
    const checklist = !request.checklist_id
      ? null
      : request.version
        ? (versions?.find((item) => item.version === request.version) ?? null)
        : latestOf(request.checklist_id);
    if (request.checklist_id && !checklist) throw new ApiError(404, 'Версия листа не найдена');
    const job: Job = { id: nextId('job'), status: 'queued', total: request.conversation_ids.length, done: 0, failed: 0, evaluation_ids: [], errors: [], current: [] };
    jobs.set(job.id, job);
    void runJob(job, request.conversation_ids, checklist, assigned, Boolean(request.force));
    return clone(job);
  },
  async getJob(id) {
    await wait(60);
    const job = jobs.get(id);
    if (!job) throw new ApiError(404, 'Задача не найдена');
    return clone(job);
  },
  async listEvaluations(conversationId) {
    await wait();
    return runs.filter((run) => run.conversation_id === conversationId).map(toEvaluationSummary).reverse();
  },
  async getEvaluation(id) {
    await wait();
    return clone(findRun(id));
  },
  async compareEvaluations(idA, idB) {
    await wait();
    const a = findRun(idA);
    const b = findRun(idB);
    if (a.status !== 'done' || b.status !== 'done') throw new ApiError(422, 'Сбойный запуск нельзя сравнить, в нём нет результатов');
    if (a.conversation_id !== b.conversation_id) throw new ApiError(422, 'Сравнить можно только запуски одного диалога');
    const delta = (first?: number | null, second?: number | null) =>
      first === null || first === undefined || second === null || second === undefined ? null : Math.round((second - first) * 100) / 100;
    const side = (run: EvaluationRun): EvaluationCompare['a'] => ({
      id: run.id,
      checklist_id: run.checklist_id,
      checklist_version: run.checklist_version,
      total: run.score.total,
      final_total: run.final_score.total,
      gross_error: run.score.gross_error,
      final_gross_error: run.final_score.gross_error,
      cache_hit: run.log.cache_hit,
      created_at: run.created_at,
    });
    const titles = new Map([...(a.checklist?.criteria ?? []), ...(b.checklist?.criteria ?? [])].map((item) => [item.id, item.title]));
    const criteria = [...titles].map(([criterion_id, title]) => {
      const first = a.score.criteria.find((item) => item.criterion_id === criterion_id) ?? null;
      const second = b.score.criteria.find((item) => item.criterion_id === criterion_id) ?? null;
      const value = (entry: typeof first) => {
        if (!entry) return null;
        const { criterion_id: _id, ...rest } = entry;
        return rest;
      };
      return {
        criterion_id,
        title,
        a: value(first),
        b: value(second),
        answer_changed: first?.status !== second?.status || first?.answer !== second?.answer,
        points_changed: first?.points !== second?.points,
        points_delta: delta(first?.points, second?.points),
      };
    });
    return {
      conversation_id: a.conversation_id,
      a: side(a),
      b: side(b),
      same_content: a.log.content_hash === b.log.content_hash,
      same_rubric: a.log.checklist_hash === b.log.checklist_hash,
      total_delta: delta(a.score.total, b.score.total),
      final_total_delta: delta(a.final_score.total, b.final_score.total),
      changed_criteria: criteria.filter((item) => item.answer_changed || item.points_changed).map((item) => item.criterion_id),
      criteria,
    };
  },
  async getReport(groupId) {
    await wait();
    const selected = conversations.filter((item) => !groupId || item.group_id === groupId);
    const latest = (id: string) => [...runs].reverse().find((run) => run.conversation_id === id);
    const rows = selected.map((item) => ({ item, run: latest(item.id) }));
    const scope = runs.filter((run) => selected.some((item) => item.id === run.conversation_id));
    const bucket = (field: 'language' | 'channel'): ReportBucket[] =>
      [...new Set(selected.map((item) => item[field]))].sort().map((key) => {
        const members = rows.filter((row) => row.item[field] === key);
        return {
          key,
          conversations: members.length,
          evaluated: members.filter((row) => row.run?.status === 'done').length,
          failed: members.filter((row) => row.run?.status === 'failed').length,
          not_evaluated: members.filter((row) => !row.run).length,
        };
      });
    const tally = new Map<string, { checklist_id: string; version: number; conversations: number }>();
    const evaluators = new Map<string, number>();
    for (const { run } of rows) {
      if (!run) continue;
      if (run.checklist_id) {
        const key = `${run.checklist_id}:${run.checklist_version}`;
        const entry = tally.get(key) ?? { checklist_id: run.checklist_id, version: run.checklist_version, conversations: 0 };
        entry.conversations += 1;
        tally.set(key, entry);
      }
      const provider = String(run.log.evaluator?.provider ?? 'mock');
      evaluators.set(provider, (evaluators.get(provider) ?? 0) + 1);
    }
    const costs = scope.flatMap((run) => (run.log.cost_usd === null ? [] : [run.log.cost_usd]));
    const latencies = scope.flatMap((run) => (run.log.latency_ms === null ? [] : [run.log.latency_ms]));
    return {
      group_id: groupId ?? null,
      generated_at: now(),
      conversations: selected.length,
      evaluated: rows.filter((row) => row.run?.status === 'done').length,
      failed: rows.filter((row) => row.run?.status === 'failed').length,
      not_evaluated: rows.filter((row) => !row.run).length,
      partial: rows.filter((row) => row.run?.score.is_partial).length,
      by_language: bucket('language'),
      by_channel: bucket('channel'),
      runs: scope.length,
      failed_runs: scope.filter((run) => run.status === 'failed').length,
      cache_hits: scope.filter((run) => run.log.cache_hit).length,
      model_attempts: scope.reduce((sum, run) => sum + run.log.attempts.length, 0),
      avg_latency_ms: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      total_cost_usd: costs.length ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
      runs_without_cost: scope.length - costs.length,
      checklists: [...tally.values()],
      evaluators: [...evaluators].map(([provider, conversations]) => ({
        provider, model: provider === 'mock' ? 'mock' : 'demo-model', pipeline: 'single', temperature: 0, max_output_tokens: 8000, conversations,
      })),
      mock_used: scope.some((run) => run.log.evaluator?.provider === 'mock'),
    };
  },
  async createAppeal(input) {
    await wait();
    const run = findRun(input.evaluation_id);
    if (!run.results.some((item) => item.criterion_id === input.criterion_id)) {
      throw new ApiError(422, 'Критерия нет в этом запуске');
    }
    const appeal: Appeal = { id: nextId('appeal'), ...input, status: 'open', created_at: now(), decision: null };
    appeals.push(appeal);
    return clone(appeal);
  },
  async listAppeals(filters = {}) {
    await wait();
    return clone(
      appeals.filter(
        (item) =>
          (!filters.status || item.status === filters.status) &&
          (!filters.evaluation_id || item.evaluation_id === filters.evaluation_id),
      ),
    );
  },
  async decideAppeal(id, decision) {
    await wait(300);
    const appeal = appeals.find((item) => item.id === id);
    if (!appeal) throw new ApiError(404, 'Апелляция не найдена');
    if (appeal.status === 'decided') throw new ApiError(409, 'По апелляции уже есть решение');
    if (!decision.reason.trim()) throw new ApiError(422, 'Нужна причина решения');
    appeal.status = 'decided';
    appeal.decision = { ...decision, decided_at: now() };
    applyDecisions(findRun(appeal.evaluation_id));
    return clone(appeal);
  },
  async exportResults(filters = {}) {
    await wait();
    const results = conversations
      .filter((item) => !filters.group_id || item.group_id === filters.group_id)
      .map((item): ExportItem => {
        const run = [...runs].reverse().find((candidate) => candidate.conversation_id === item.id && (!filters.checklist_id || candidate.checklist_id === filters.checklist_id));
        return {
          conversation_id: item.id,
          group_id: item.group_id,
          channel: item.channel,
          language: item.language,
          status: run?.status ?? 'not_evaluated',
          error: run?.error ?? null,
          evaluation_id: run?.id ?? null,
          checklist_id: run?.checklist_id ?? null,
          checklist_version: run?.checklist_version ?? null,
          total: run?.score.total ?? null,
          partial_total: run?.score.partial_total ?? null,
          is_partial: run?.score.is_partial ?? false,
          gross_error: run?.score.gross_error ?? false,
          review_status: run?.review_status ?? null,
          review_reasons: run?.review_reasons ?? [],
          criteria: (run?.score.criteria ?? []).map(({ effective_weight: _effective, ...entry }) => entry),
        };
      });
    const count = (status: ExportItem['status']) => results.filter((item) => item.status === status).length;
    return {
      group_id: filters.group_id ?? null,
      generated_at: now(),
      total: results.length,
      done: count('done'),
      failed: count('failed'),
      not_evaluated: count('not_evaluated'),
      results,
    };
  },
  async exportCsv(filters) {
    const { results } = await mockApi.exportResults(filters);
    const columns = ['conversation_id', 'status', 'total', 'gross_error'] as const;
    return [columns.join(','), ...results.map((item) => columns.map((key) => item[key] ?? '').join(','))].join('\n');
  },
};
