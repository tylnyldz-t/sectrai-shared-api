import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestExtensions, type Extension } from '../src/gcl/extensions.js'

test('extension suggestions are pure, consent-gated, and cannot activate an extension', () => {
  const extensions: Extension[] = [
    { id: 'one', name: 'External Search', sector: ['construction'], role: 'ai-support', connectorId: 'connector-example', defaultScopes: ['search:read'], consentState: 'granted' },
    { id: 'two', name: 'Private Leads', sector: ['construction'], role: 'add-on-module', connectorId: 'private-leads', defaultScopes: ['leads:read'], consentState: 'pending' },
  ]
  const suggestions = suggestExtensions({ sector: 'construction', activeModules: ['search:read'], lastCommand: 'find news' }, extensions)
  assert.deepEqual(suggestions.map((suggestion) => suggestion.id), ['one'])
  assert.equal(suggestions[0]?.requiresOwnerApproval, true)
  assert.equal(extensions[0]?.consentState, 'granted')
})
