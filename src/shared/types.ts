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

export interface CoderResult {
  status: 'manual' | 'success' | 'error'
  message: string
  filesChanged?: string[]
}
