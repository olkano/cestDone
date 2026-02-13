// src/shared/types.ts

export type PhaseStatus = 'pending' | 'in-progress' | 'done'

export interface Phase {
  number: number
  name: string
  status: PhaseStatus
  spec: string
  done: string
}

export interface SpecMetadata {
  context: string
  houseRulesRef: string
  houseRulesContent?: string
}

export interface ParsedSpec {
  title: string
  metadata: SpecMetadata
  phases: Phase[]
}

export interface Config {
  defaultModel: string
  targetRepoPath: string
  logLevel: string
  maxTurns: number
  maxBudgetUsd?: number
}

export interface ResolvedConfig extends Config {
  apiKey: string
}

export enum WorkflowStep {
  Analyze = 1,
  Clarify = 2,
  UpdateSpec = 3,
  Plan = 4,
  ApprovePlan = 5,
  Execute = 6,
  Review = 7,
  Complete = 8,
}

export type DirectorActionType = 'approve' | 'ask_human' | 'fix' | 'complete'

export interface DirectorAction {
  action: DirectorActionType
  message: string
  questions?: string[]
}

export type Complexity = 'low' | 'high'

export interface CoderReport {
  status: 'success' | 'error' | 'partial'
  summary: string
  filesChanged?: string[]
  testResults?: string
  questions?: string[]
}

export interface CoderResult {
  status: 'manual' | 'success' | 'error' | 'partial'
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
  logLevel: string
}
