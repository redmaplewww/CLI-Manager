export function normalizeCliPrompt(prompt: string): string {
  let text = prompt.trim()
  text = normalizeWorkflowAuto(text)
  return text
}

function normalizeWorkflowAuto(text: string): string {
  if (!/(workflow-auto|\/workflow-auto)/i.test(text)) return text

  return [
    'Workflow mode: workflow-auto. Treat this as full-auto workflow execution, not as a slash-command or prompt-based skill invocation.',
    'Do not call Skill with workflow-auto, and do not report Unknown skill: workflow-auto. Execute the requested task directly and autonomously to completion.',
    workflowAutoTaskText(text),
  ].join('\n')
}

function workflowAutoTaskText(text: string): string {
  const cleaned = text
    .replace(/^\s*\/workflow-auto\s*/i, '')
    .replace(
      /(?:使用|启用|调用|进入|用|use|run|invoke)\s*\/?workflow-auto\s*(?:skill|技能|模式)?/i,
      '',
    )
    .replace(/^[，,。.:：;；\s]+/, '')
    .trim()
  return `Task: ${cleaned || text.trim()}`
}
