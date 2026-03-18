export type CommentSeverity = 'critical' | 'important' | 'minor' | 'noise';

export type ArbiterDecision = 'fix' | 'submit' | 'escalate';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'escalated';

export type TaskStatus = 'in_progress' | 'review' | 'done' | 'blocked' | 'escalated';


export type CopilotErrorCode = 'not_found' | 'review_failed' | 'parse_failed';
export type CodexErrorCode =
  | 'submit_failed'
  | 'resume_failed'
  | 'poll_timeout'
  | 'poll_failed'
  | 'diff_empty'
  | 'apply_failed';

export interface ServiceConfig {
  name: string;
  path: string;
  env_id?: string;
}

export interface ReviewConfig {
  model: string;
  max_iterations: number;
  auto_submit: boolean;
}

export interface CodexConfig {
  model: string;
  base_branch: string;
}

export interface VexdoConfig {
  version: 1;
  services: ServiceConfig[];
  review: ReviewConfig;
  codex: CodexConfig;
  maxConcurrent?: number;
}

export interface TaskStep {
  service: string;
  spec: string;
  depends_on?: string[];
}

export interface Task {
  id: string;
  title: string;
  steps: TaskStep[];
  depends_on?: string[];
}

export interface ReviewComment {
  severity: CommentSeverity;
  file?: string;
  line?: number;
  comment: string;
  suggestion?: string;
}

export interface ReviewResult {
  comments: ReviewComment[];
}

export interface ArbiterResult {
  decision: ArbiterDecision;
  reasoning: string;
  feedback_for_codex?: string;
  summary: string;
}

export interface StepState {
  service: string;
  status: StepStatus;
  iteration: number;
  currentStepIndex: number;
  branch?: string;
  lastReview?: string;
  lastArbiterResult?: ArbiterResult;
  session_id?: string;
}

export interface VexdoState {
  taskId: string;
  taskTitle: string;
  taskPath: string;
  status: TaskStatus;
  steps: StepState[];
  startedAt: string;
  updatedAt: string;
}

export interface StartOptions {
  dryRun?: boolean;
  verbose?: boolean;
  resume?: boolean;
}

export interface IterationLog {
  taskId: string;
  service: string;
  iteration: number;
  diff: string;
  review: string;
  arbiter: ArbiterResult;
  timestamp: string;
}
