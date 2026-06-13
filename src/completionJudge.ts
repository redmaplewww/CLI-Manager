import type { TaskRecord, TaskStatus } from './types'

export type CompletionVerdict = 'done' | 'needs_review' | 'not_done' | 'in_progress' | 'uncertain'

export interface CompletionJudgement {
  verdict: CompletionVerdict
  done: boolean
  reason: string
  positiveSignals: string[]
  negativeSignals: string[]
}

const positiveSignals = [
  '完成',
  '已完成',
  'pass',
  'passed',
  'success',
  'successful',
  'done',
  'ready',
  '生成',
  '写入',
  'created',
  'updated',
]

const negativeSignals = [
  'failed',
  'failure',
  'error',
  '报错',
  '失败',
  'blocked',
  '无法',
  'not found',
  'missing',
  'exception',
  'timeout',
]

export function judgeTaskCompletion(
  task: TaskRecord,
  output: string,
): CompletionJudgement {
  const criteria = task.completionCriteria ?? ''
  const lower = output.toLowerCase()
  const positive = positiveSignals.filter(word => lower.includes(word.toLowerCase()))
  const negative = negativeSignals.filter(word =>
    hasNegativeSignal(lower, word.toLowerCase()),
  )
  const criteriaItems = criteria
    .split(/\r?\n|(?:^|\s)\d+[.)、]/)
    .map(item => item.trim())
    .filter(item => item.length > 6)
  const criteriaCovered = criteriaItems.filter(item => fuzzyCovered(output, item))
  const hasCriteria = criteriaItems.length > 0
  const coverageOk = !hasCriteria || criteriaCovered.length >= Math.ceil(criteriaItems.length * 0.6)
  const fullyCovered = !hasCriteria || criteriaCovered.length === criteriaItems.length
  const terminalBad = ['failed', 'stuck', 'cancelled'].includes(task.status)
  const terminalGood = task.status === 'completed'
  const reviewStuck =
    task.status === 'stuck' &&
    /completion criteria not satisfied/i.test(task.errorMessage ?? '')
  const exitedCleanly = /(?:进程退出|process exited|exit|exited)[\s\S]{0,80}(?:"code"\s*:\s*0|code=0|exit code 0)/i.test(output)

  let verdict: CompletionVerdict = 'in_progress'
  if (reviewStuck && positive.length > 0 && fullyCovered) verdict = 'done'
  else if (terminalBad && positive.length > 0 && coverageOk && negative.length === 0)
    verdict = 'done'
  else if (terminalBad) verdict = 'not_done'
  else if (terminalGood && negative.length > 0) verdict = 'needs_review'
  else if (terminalGood && positive.length > 0 && coverageOk) verdict = 'done'
  else if (terminalGood) verdict = 'needs_review'
  else if (exitedCleanly && positive.length > 0 && coverageOk) verdict = 'done'

  return {
    verdict,
    done: verdict === 'done',
    positiveSignals: positive,
    negativeSignals: negative,
    reason: [
      `task status=${task.status}`,
      `positive signals=${positive.join(', ') || '-'}`,
      `negative signals=${negative.join(', ') || '-'}`,
      `criteria coverage=${hasCriteria ? `${criteriaCovered.length}/${criteriaItems.length}` : 'not_set'}`,
      `clean exit=${exitedCleanly ? 'yes' : 'no'}`,
      criteria ? `criteria=${criteria}` : 'criteria=未设置',
    ].join('\n'),
  }
}

export function recoveryPromptForIncomplete(task: TaskRecord, reason: string): string {
  return [
    'Continue and recover this task. Do not treat prior CLI exit as completion unless the completion criteria are satisfied.',
    `Original task: ${task.prompt}`,
    task.completionCriteria ? `Completion criteria:\n${task.completionCriteria}` : '',
    `Current judgement:\n${reason}`,
    'Inspect existing outputs/artifacts first, identify what is missing, then continue execution until criteria are satisfied. If blocked, report exact blocker and next command/file needed.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function fuzzyCovered(output: string, criterion: string): boolean {
  const words = criterion
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s_-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2 && !/^\d+$/.test(word))
  if (words.length === 0) return true
  const lower = output.toLowerCase()
  const hits = words.filter(word => lower.includes(word)).length
  return hits >= Math.max(1, Math.ceil(words.length * 0.45))
}

function hasNegativeSignal(lowerOutput: string, word: string): boolean {
  if (word === 'error') {
    return /(?:^|\n|\r|\s)(?:error|errors)(?:\s*[:=]|\s+(?:occurred|found|detected|during))(?!\s*0\b)/i.test(lowerOutput)
  }
  if (word === 'failed' || word === 'failure') {
    return new RegExp(`(?:^|\\n|\\r|\\s)${word}(?:\\s*[:=]|\\b)`, 'i').test(lowerOutput)
  }
  if (word === 'blocked' || word === 'missing') {
    return new RegExp(`(?:^|\\n|\\r|\\s)${word}(?:\\s*[:=]|\\s+(?:item|items|file|files|dependency|dependencies|requirement|requirements|criteria)|\\b)`, 'i').test(lowerOutput)
  }
  return lowerOutput.includes(word)
}
