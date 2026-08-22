#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregateUsage, fridayWeeklyWindow } from './aggregate.js'
import type { InvocationType } from '../shared/types.js'

interface Args {
  usageDir: string
  timezone: string
  output?: string
  start?: string
  end?: string
  weeksAgo: number
  applications?: string[]
  invocationTypes?: InvocationType[]
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    usageDir: path.join(os.homedir(), '.cestdone', 'usage'),
    timezone: 'Europe/Madrid',
    weeksAgo: 0,
  }
  const value = (index: number, name: string): string => {
    const result = argv[index + 1]
    if (!result || result.startsWith('--')) throw new Error(`${name} requires a value`)
    return result
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--usage-dir': args.usageDir = value(i++, '--usage-dir'); break
      case '--timezone': args.timezone = value(i++, '--timezone'); break
      case '--output': args.output = value(i++, '--output'); break
      case '--start': args.start = value(i++, '--start'); break
      case '--end': args.end = value(i++, '--end'); break
      case '--weeks-ago': args.weeksAgo = Number(value(i++, '--weeks-ago')); break
      case '--applications': args.applications = value(i++, '--applications').split(',').filter(Boolean); break
      case '--invocation-types': args.invocationTypes = value(i++, '--invocation-types').split(',').filter(Boolean) as InvocationType[]; break
      default: throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  if ((args.start === undefined) !== (args.end === undefined)) {
    throw new Error('--start and --end must be provided together')
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const period = args.start && args.end
    ? { start: new Date(args.start), end: new Date(args.end), timezone: args.timezone }
    : fridayWeeklyWindow(new Date(), args.timezone, args.weeksAgo)
  if (!Number.isFinite(period.start.getTime()) || !Number.isFinite(period.end.getTime())) {
    throw new Error('Invalid start or end timestamp')
  }
  const snapshot = aggregateUsage({
    usageDir: path.resolve(args.usageDir),
    ...period,
    applications: args.applications,
    invocationTypes: args.invocationTypes,
  })
  const json = JSON.stringify(snapshot, null, 2) + '\n'
  if (args.output) {
    const output = path.resolve(args.output)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, json, 'utf-8')
    console.log(output)
  } else {
    process.stdout.write(json)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
