// src/cli/prompt.ts
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'

export interface PromptOptions {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export function ensureTTY(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      'cestdone requires an interactive terminal (TTY). ' +
      'Pipe and non-interactive environments are not supported in Phase 0.'
    )
  }
}

export async function askApproval(
  options?: PromptOptions
): Promise<{ approved: boolean; feedback?: string }> {
  const rl = makeReadline(options)
  const output = options?.output ?? process.stdout

  return new Promise((resolve) => {
    let waitingForFeedback = false

    output.write('Approve this plan? (y = proceed, n = request changes): ')

    rl.on('line', (line) => {
      if (!waitingForFeedback) {
        const normalized = line.trim().toLowerCase()
        if (normalized === 'y' || normalized === 'yes') {
          rl.close()
          resolve({ approved: true })
        } else {
          waitingForFeedback = true
          output.write('Feedback (what should change?): ')
        }
      } else {
        rl.close()
        resolve({ approved: false, feedback: line.trim() })
      }
    })
  })
}

export async function askInput(
  prompt: string,
  options?: PromptOptions
): Promise<string> {
  const rl = makeReadline(options)
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function makeReadline(options?: PromptOptions): ReadlineInterface {
  return createInterface({
    input: options?.input ?? process.stdin,
    output: options?.output ?? process.stdout,
  })
}
