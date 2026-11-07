// Mirrors ai/src/cqa_ai/contracts.py, the HTTP section of CONTRACTS.md and the
// additions in backend/src/cqa_backend/schemas.py.
// Field names stay in snake_case on purpose: this is the wire format.

export type CriterionType = 'boolean' | 'scale';
export type ResultStatus = 'assessed' | 'not_applicable' | 'unassessable' | 'failed';
export type ReviewStatus = 'clear' | 'flagged';
export type Answer = 'yes' | 'no' | number | null;

export type Turn = { index: number; timestamp: string; speaker: string; text: string };

export type Section = { id: string; title: string };
export type ScaleLevel = { value: number; text: string };

export type Criterion = {
  id: string;
  section: string;
  title: string;
  type: CriterionType;
  weight: number;
  scored: boolean;
  flag: string | null;
  allow_na: boolean;
  yes_when: string | null;
  prompt: string | null;
  na_when: string | null;
  levels: ScaleLevel[];
  team_notes: string[];
  /** Notes switched off. Absent on a backend that cannot switch notes off. */
  disabled_notes?: string[];
};

export type ChecklistVersion = {
  checklist_id: string;
  version: number;
  title: string;
  channels: string[];
  excluded_from_scoring: string[];
  sections: Section[];
  criteria: Criterion[];
};

export type Evidence = { turn_index: number; quote: string };
export type TurnRange = { from_turn: number; to_turn: number };

export type CriterionResult = {
  criterion_id: string;
  status: ResultStatus;
  answer: Answer;
  justification: string;
  evidence: Evidence[];
  reviewed_range: TurnRange | null;
  expected_at_turn: number | null;
  review_flags: string[];
  /** W7 decision trace. Optional: older runs do not have it. */
  analysis?: string | null;
  rule_ref?: string | null;
  /** The rubric text rule_ref points to, as the model saw it. */
  rule_text?: string | null;
  /** Code facts (greeting, escalation, waits, closing…) on the turns the decision cites. */
  facts_used?: string[] | null;
  alternative?: string | null;
  confidence?: number | null;
  votes?: JudgeVote[] | null;
};

export type JudgeVote = {
  model: string;
  status: ResultStatus;
  answer: Answer;
  justification: string;
};

export type CriterionScore = {
  criterion_id: string;
  status: ResultStatus;
  answer: Answer;
  weight: number;
  effective_weight: number | null;
  points: number | null;
};

export type SectionScore = {
  section_id: string;
  title: string;
  earned: number;
  possible: number;
  percent: number | null;
  flags: string[];
};

export type ScoreSummary = {
  total: number | null;
  partial_total: number | null;
  is_partial: boolean;
  missing_criteria: string[];
  gross_error: boolean;
  gross_error_criteria: string[];
  criteria: CriterionScore[];
  sections: SectionScore[];
};

export type ModelAttempt = {
  provider: string;
  model: string;
  role: string;
  attempt: number;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  valid: boolean;
  errors: string[];
};

export type ImportResult = {
  group_id: string;
  imported: number;
  skipped: number;
  conversation_ids: string[];
  /** Holds warnings too, marked with the `warning:` prefix. */
  errors: string[];
};

export type ConversationSummary = {
  id: string;
  channel: string;
  language: string;
  turn_count: number;
  has_audio: boolean;
  group_id: string | null;
  latest_evaluation_id: string | null;
  latest_total: number | null;
  gross_error: boolean;
  // Optional: without them the list reads each run itself.
  latest_status?: 'done' | 'failed' | null;
  latest_error?: string | null;
  latest_reasons?: string[];
  latest_evaluated_at?: string | null;
  review_status?: ReviewStatus | null;
  open_appeals?: number;
};
export type ConversationDetail = ConversationSummary & { turns: Turn[] };
export type TranscriptResult = ConversationSummary & { warnings: string[] };

export type ChecklistSummary = {
  checklist_id: string;
  title: string;
  latest_version: number;
  channels: string[];
};

export type EvaluationRequest = {
  conversation_ids: string[];
  /** Empty: the backend picks a checklist per dialogue by its channel. */
  checklist_id?: string;
  /** Requires checklist_id. */
  version?: number;
  /** Channel to checklist id, latest version. Cannot go with checklist_id. Other channels stay automatic. */
  checklists_by_channel?: Record<string, string>;
  force?: boolean;
};

export type StageId = 'parse' | 'model' | 'validate' | 'score';

/** What one dialogue of a running job is doing now. */
export type JobStage = { conversation_id: string; stage: StageId; started_at: string };

export type Job = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  evaluation_ids: string[];
  errors: string[];
  /** Absent on a backend that does not report stages. */
  current?: JobStage[];
};

export type EvaluationSummary = {
  id: string;
  conversation_id: string;
  checklist_id: string;
  checklist_version: number;
  status: 'done' | 'failed';
  total: number | null;
  final_total: number | null;
  gross_error: boolean;
  created_at: string;
  /** Failure text. A failed run has status `failed`, empty results and a null total. */
  error: string | null;
};

export type RunLog = {
  run_id: string;
  content_hash: string;
  checklist_hash: string;
  prompt_hash: string;
  pipeline: string;
  attempts: ModelAttempt[];
  cache_hit: boolean;
  latency_ms: number | null;
  cost_usd: number | null;
  cached_from: string | null;
  evaluator: Record<string, unknown> | null;
  /** Absent on older runs. A cache hit has no model stage. */
  stages?: { id: StageId; ms: number }[] | null;
};

export type EvaluationRun = EvaluationSummary & {
  results: CriterionResult[];
  score: ScoreSummary;
  final_results: CriterionResult[];
  final_score: ScoreSummary;
  /** Null on a failed run whose channel has no checklist: then checklist_id is "" and version 0. */
  checklist: ChecklistVersion | null;
  review_status: ReviewStatus;
  review_reasons: string[];
  log: RunLog;
};

export type ExportCriterion = Pick<CriterionScore, 'criterion_id' | 'status' | 'answer' | 'weight' | 'points'>;

export type ExportItem = {
  conversation_id: string;
  group_id: string | null;
  channel: string;
  language: string;
  status: 'done' | 'failed' | 'not_evaluated';
  error: string | null;
  evaluation_id: string | null;
  checklist_id: string | null;
  checklist_version: number | null;
  total: number | null;
  partial_total: number | null;
  is_partial: boolean;
  gross_error: boolean;
  review_status: ReviewStatus | null;
  review_reasons: string[];
  criteria: ExportCriterion[];
};

export type ExportResult = {
  group_id: string | null;
  generated_at: string;
  total: number;
  done: number;
  failed: number;
  not_evaluated: number;
  results: ExportItem[];
};

export type ReportBucket = {
  key: string;
  conversations: number;
  evaluated: number;
  failed: number;
  not_evaluated: number;
};

export type ReportChecklist = { checklist_id: string; version: number; conversations: number };

export type ReportEvaluator = {
  provider: string;
  model: string;
  pipeline: string;
  temperature: number | null;
  max_output_tokens: number;
  conversations: number;
};

export type ReportSummary = {
  group_id: string | null;
  generated_at: string;
  conversations: number;
  evaluated: number;
  failed: number;
  not_evaluated: number;
  partial: number;
  by_language: ReportBucket[];
  by_channel: ReportBucket[];
  runs: number;
  failed_runs: number;
  cache_hits: number;
  model_attempts: number;
  avg_latency_ms: number | null;
  total_cost_usd: number | null;
  runs_without_cost: number;
  checklists: ReportChecklist[];
  evaluators: ReportEvaluator[];
  mock_used: boolean;
};

export type CompareSide = {
  id: string;
  checklist_id: string;
  checklist_version: number;
  total: number | null;
  final_total: number | null;
  gross_error: boolean;
  final_gross_error: boolean;
  cache_hit: boolean;
  created_at: string;
};

export type CompareValue = {
  status: ResultStatus;
  answer: Answer;
  weight: number;
  effective_weight: number | null;
  points: number | null;
};

export type CompareCriterion = {
  criterion_id: string;
  title: string;
  a: CompareValue | null;
  b: CompareValue | null;
  answer_changed: boolean;
  points_changed: boolean;
  points_delta: number | null;
};

export type EvaluationCompare = {
  conversation_id: string;
  a: CompareSide;
  b: CompareSide;
  same_content: boolean;
  same_rubric: boolean;
  total_delta: number | null;
  final_total_delta: number | null;
  changed_criteria: string[];
  criteria: CompareCriterion[];
};

export type AppealCreate = { evaluation_id: string; criterion_id: string; comment: string };

export type DecisionCreate = {
  decision: 'confirm' | 'change';
  new_answer?: Answer;
  new_status?: 'assessed' | 'not_applicable';
  reason: string;
  reviewer: string;
};

export type Appeal = {
  id: string;
  evaluation_id: string;
  criterion_id: string;
  comment: string;
  status: 'open' | 'decided';
  created_at: string;
  decision: (DecisionCreate & { decided_at: string }) | null;
};
