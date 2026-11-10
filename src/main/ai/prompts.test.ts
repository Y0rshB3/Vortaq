import { describe, expect, it } from 'vitest'
import type { AiChatRequest } from '@shared/ai'
import { modeInstruction, SYSTEM_INSTRUCTIONS } from './prompts'

const generate = { mode: 'generateSql' } as AiChatRequest

describe('prompts', () => {
  it('does not tie the frozen instructions to MySQL', () => {
    expect(SYSTEM_INSTRUCTIONS).not.toMatch(/MySQL client|their own MySQL/)
    expect(SYSTEM_INSTRUCTIONS).toMatch(/PostgreSQL, SQLite, SQL Server and MongoDB/)
  })

  it('asks for SQL in the dialect of the connection', () => {
    expect(modeInstruction(generate)).toMatch(/^Task: write ONE MySQL statement/)
    expect(modeInstruction(generate, 'postgresql')).toMatch(/^Task: write ONE PostgreSQL statement/)
    expect(modeInstruction(generate, 'sqlite')).toMatch(/^Task: write ONE SQLite statement/)
    expect(modeInstruction(generate, 'mongodb')).toMatch(/MongoDB shell command/)
  })
})
