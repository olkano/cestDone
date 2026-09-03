import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('PM2 ecosystem configuration', () => {
  it('loads the ignored runtime environment file for the daemon', () => {
    const ecosystem = require('../ecosystem.config.cjs')

    expect(ecosystem.apps[0]).toMatchObject({
      name: 'cestdone-daemon',
      node_args: '--env-file=.env',
    })
  })
})
