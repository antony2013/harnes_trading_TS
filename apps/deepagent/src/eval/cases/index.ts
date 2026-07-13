// apps/deepagent/src/eval/cases/index.ts
import type { EvalCase } from '../types'
import { instrumentResolutionCases } from './instrument-resolution'
import { candleSyncCases } from './candle-sync'
import { readFilePaginationCases } from './read-file-pagination'
import { orchestrationCases } from './orchestration'

export const ALL_CASES: EvalCase[] = [
  ...instrumentResolutionCases,
  ...candleSyncCases,
  ...readFilePaginationCases,
  ...orchestrationCases,
]