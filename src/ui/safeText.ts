const asciiMap: Record<string, string> = {
  对话: 'Chat',
  规则: 'Rules',
  管家: 'Butler',
  计划: 'Plan',
  任务分配: 'Tasks',
  自主项目: 'Projects',
  输入给管家: 'Input',
  统一管理窗口已启动: 'dashboard ready',
  快捷键: 'Keys',
  或: 'or',
  退出: 'exit',
  工作过程: 'Worker Process',
  管家计划: 'Plan',
  执行动作: 'Action',
  错误: 'Error',
  你: 'You',
  任务: 'Task',
  当前观察任务: 'Observed task',
  项目: 'Project',
  自主: 'Autonomous',
  状态: 'Status',
  已完成: 'Completed',
  失败: 'Failed',
  运行中: 'Running',
  排队中: 'Queued',
  等待确认: 'Waiting',
  疑似卡住: 'Stuck',
  已取消: 'Cancelled',
  已总结: 'Summarized',
  项目目录: 'Project root',
  工作目录: 'CWD',
  进程: 'PID',
  命令: 'Command',
  会话: 'Session',
  创建: 'Created',
  更新: 'Updated',
  等待回答: 'Waiting question',
  失败原因: 'Failure reason',
  最新结果: 'Latest result',
  暂无任务: 'No tasks',
  暂无自主项目: 'No projects',
  事件摘要: 'Events',
  错误输出尾部: 'stderr tail',
  暂无: 'No',
  日志: 'logs',
  模型: 'model',
  系统初始化: 'system init',
  助手回复: 'assistant',
  思考中: 'thinking',
  成功: 'success',
  执行完成: 'done',
  进程退出: 'process exit',
  任务完成: 'task completed',
  会话编号: 'session id',
  原始事件: 'event',
  调用工具: 'tool use',
  工具结果: 'tool result',
  无: 'None',
}

export function safeText(text: string, ascii = false): string {
  if (!ascii) return text
  let out = text
  for (const [from, to] of Object.entries(asciiMap))
    out = out.split(from).join(to)
  return out.replace(/[\u0080-\uffff]/g, '')
}

export function safeLines(text: string, ascii = false): string {
  return safeText(text, ascii)
}
