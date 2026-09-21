import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
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

  it('passes the full reloaded root config through the PM2 wrapper', () => {
    const wrapper = fs.readFileSync(path.resolve('cestdone-pm2.cjs'), 'utf8')
    expect(wrapper).toContain('onReload: function(newConfig)')
    expect(wrapper).toContain('daemon.reload(newConfig)')
    expect(wrapper).not.toContain('daemon.reload(newConfig.daemon)')
  })
})
