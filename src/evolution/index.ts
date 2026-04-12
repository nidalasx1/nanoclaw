// ---------------------------------------------------------------------------
// Barrel file — re-exports for the self-evolution pipeline
// ---------------------------------------------------------------------------

export * from './types.js';
export { collectTrace, getRecentTraces, getTracesForSkill, initTraceSchema } from './trace-collector.js';
export { analyzeTrace, shouldEvolve, buildAnalysisPrompt, getFailureReport, categorizeFailure } from './failure-analyzer.js';
export { buildMutationPrompt, generateMutation } from './mutation-generator.js';
export { testMutation, validateStructure, checkSemanticDrift } from './mutation-tester.js';
export { commitMutation, getEvolutionLog, rollbackMutation, initEvolutionSchema, getRecentEvolutionCount } from './auto-committer.js';
export { scheduleEvolution, runEvolutionCycle, isRateLimited, initEvolution, stopEvolution } from './evolution-scheduler.js';
