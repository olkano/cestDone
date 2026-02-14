// src/shared/types.ts
import type { SessionLogger } from './logger.js'

export type PhaseStatus = 'pending' | 'in-progress' | 'done'

export interface Phase {
  number: number
  name: string
  status: PhaseStatus
  spec: string
  applicableRules: string
  done: string
}


export interface Config {
  defaultModel: string
  targetRepoPath: string
  maxTurns: number
  maxBudgetUsd?: number
}

export interface ResolvedConfig extends Config {
  apiKey: string
}

export enum WorkflowStep {
  Analyze = 1,
  Clarify = 2,
  CreatePlan = 3,
  Plan = 4,
  ApprovePlan = 5,
  Execute = 6,
  Review = 7,
  Complete = 8,
}

export type DirectorActionType = 'analyze' | 'ask_human' | 'approve' | 'fix' | 'continue' | 'done' | 'escalate'

export interface DirectorResponse {
  action: DirectorActionType
  message: string
  questions?: string[]
}

export type Complexity = 'low' | 'high'

export interface CoderReport {
  status: 'success' | 'partial' | 'failed'
  summary: string
  filesChanged?: string[]
  testsRun?: { passed: number; failed: number; skipped: number }
  issues?: string[]
}

export interface CoderResult {
  status: 'success' | 'partial' | 'failed'
  message: string
  filesChanged?: string[]
  cost: number
  numTurns: number
  durationMs: number
  report: CoderReport | null
}

export interface CoderOptions {
  step: WorkflowStep
  phase: Phase
  model: string
  targetRepoPath: string
  houseRulesContent: string
  instructions: string
  maxTurns: number
  maxBudgetUsd?: number
  apiKey: string
  logger: SessionLogger
  completedSubPhases?: string[]
}

export interface FreeFormSpec {
  text: string
  houseRulesContent: string
  specFilePath: string
}

export interface Plan {
  title: string
  context: string
  techStack: string
  houseRules: string
  phases: Phase[]
}
