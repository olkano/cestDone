import assert from 'node:assert/strict'
import test from 'node:test'
import { sum } from './sum.mjs'

test('adds positive integers', () => {
  assert.equal(sum(2, 3), 5)
})

test('adds values that cancel out', () => {
  assert.equal(sum(-2, 2), 0)
})
