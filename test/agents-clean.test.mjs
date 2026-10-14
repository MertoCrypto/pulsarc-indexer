import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimUri } from '../src/agents.mjs'

const profile = obj => 'data:application/json;base64,' + Buffer.from(JSON.stringify(obj)).toString('base64')

test('agent names lose direction-override and zero-width characters', () => {
  const out = slimUri(profile({ name: '‮tnegA​ lacoL', description: 'a⁦b﻿c' }))
  assert.equal(out.name, 'tnegA lacoL')
  assert.equal(out.description, 'abc')
})

test('control characters and whitespace runs still become one space', () => {
  const out = slimUri(profile({ name: 'Agent\n\t  One', description: 'x\u0007y' }))
  assert.equal(out.name, 'Agent One')
  assert.equal(out.description, 'x y')
})

test('Turkish letters and emoji are kept', () => {
  assert.equal(slimUri(profile({ name: 'Çağrı İş 🚀' })).name, 'Çağrı İş 🚀')
})

test('a name made only of invisible characters is dropped', () => {
  assert.equal(slimUri(profile({ name: '​‮' })).name, undefined)
})
