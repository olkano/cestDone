import fs from 'node:fs'

const args = process.argv.slice(2)
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()

const schemaIndex = args.indexOf('--output-schema')
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : undefined
const schema = schemaPath && fs.existsSync(schemaPath)
  ? JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  : null
const report = {
  args,
  prompt,
  schemaPresentDuringProcess: Boolean(schema),
  schema,
  path: process.env.PATH,
  codexHome: process.env.CODEX_HOME,
}
fs.appendFileSync(process.env.CESTDONE_TRANSPORT_REPORT, `${JSON.stringify(report)}\n`)

if (prompt === 'FAIL') {
  process.stderr.write('synthetic transport failure\n')
  process.exitCode = 7
} else {
  const resumeIndex = args.indexOf('resume')
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'transport-thread'
  if (resumeIndex < 0) process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: `message-${resumeIndex >= 0 ? 2 : 1}`, type: 'agent_message', text: '{"action":"done","message":"ok","questions":null}' } })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: resumeIndex >= 0
    ? { input_tokens: 20, cached_input_tokens: 4, output_tokens: 8, reasoning_output_tokens: 2 }
    : { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 } })}\n`)
}
