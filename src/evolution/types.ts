// ---------------------------------------------------------------------------
// Shared types for the self-evolution pipeline
// ---------------------------------------------------------------------------

export interface ExecutionTrace {
  id: string;
  groupId: string;
  sessionId: string;
  timestamp: string;
  toolCalls: Array<{
    name: string;
    input?: string;
    output?: string;
    success: boolean;
  }>;
  skillsLoaded: string[];
  skillsDeviated: Array<{
    skillName: string;
    deviationScore: number;
    deviatedSteps: string[];
  }>;
  outcome: 'success' | 'partial' | 'failure';
  summary?: string;
}

export type FailureCategory =
  | 'wrong_sequence'
  | 'missing_step'
  | 'outdated_info'
  | 'edge_case'
  | 'tool_unavailable'
  | 'unknown';

export interface FailureReport {
  skillName: string;
  category: FailureCategory;
  evidence: string[];
  suggestedFix: string;
  traceIds: string[];
  confidence: number; // 0-1
  timestamp: string;
}

export interface MutationCandidate {
  skillName: string;
  originalContent: string;
  mutatedContent: string;
  reason: string;
  failureReport: FailureReport;
  diffSummary: string;
}

export interface ValidatedMutation {
  skillName: string;
  content: string;
  reason: string;
  version: string;
  previousVersion: string;
  passed: boolean;
  errors?: string[];
}

export interface EvolutionLogEntry {
  id: string;
  skillName: string;
  previousVersion: string;
  newVersion: string;
  reason: string;
  category: FailureCategory;
  mutatedAt: string;
  rolledBack: boolean;
}
