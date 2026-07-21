export type ExtensionRole = 'ai-support' | 'add-on-module'
export type ConsentState = 'pending' | 'granted' | 'revoked'

export type Extension = {
  id: string
  name: string
  sector: string[]
  role: ExtensionRole
  connectorId: string
  defaultScopes: string[]
  consentState: ConsentState
}

export type ExtensionInput = Omit<Extension, 'id'>

export type ExtensionSuggestionInput = {
  sector: string
  activeModules: string[]
  lastCommand: string | null
}

export type ExtensionSuggestion = Extension & {
  requiresOwnerApproval: true
  reason: string
}

function words(value: string): Set<string> { return new Set(value.toLocaleLowerCase('tr-TR').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2)) }

/**
 * This is intentionally a pure, deterministic recommendation policy. It only
 * proposes consent-granted extensions and never changes activation state.
 */
export function suggestExtensions(input: ExtensionSuggestionInput, extensions: readonly Extension[]): ExtensionSuggestion[] {
  const requestedSector = input.sector.toLocaleLowerCase('tr-TR')
  const commandWords = words(input.lastCommand ?? '')
  const activeModules = new Set(input.activeModules.map((moduleId) => moduleId.toLocaleLowerCase('tr-TR')))
  return extensions
    .filter((extension) => extension.consentState === 'granted')
    .map((extension) => {
      const sectorMatch = extension.sector.some((sector) => sector.toLocaleLowerCase('tr-TR') === requestedSector)
      const extensionWords = words(`${extension.name} ${extension.connectorId} ${extension.defaultScopes.join(' ')}`)
      const commandMatch = [...commandWords].some((word) => extensionWords.has(word))
      const activeScopeMatch = extension.defaultScopes.some((scope) => activeModules.has(scope.toLocaleLowerCase('tr-TR')))
      const score = (sectorMatch ? 4 : 0) + (commandMatch ? 2 : 0) + (activeScopeMatch ? 1 : 0)
      return { extension, score, reason: sectorMatch ? 'sector-match' : commandMatch ? 'last-command-match' : 'active-module-match' }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.extension.name.localeCompare(right.extension.name))
    .slice(0, 10)
    .map(({ extension, reason }) => ({ ...extension, requiresOwnerApproval: true, reason }))
}
