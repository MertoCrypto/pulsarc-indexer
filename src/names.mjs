// Display names for indexer app ids.
// Built from src/data/apps.ts (ARC_APPS) plus the ids in apps.mainnet.json / apps.testnet.json.
// Unknown ids fall back to their id with the first letter capitalised.

export const NAMES = {
  // From ARC_APPS (apps.ts)
  usdc:           'USDC',
  eurc:           'EURC',
  usyc:           'USYC',
  cirbtc:         'cirBTC',
  weth:           'WETH',
  stablefx:       'StableFX',
  memo:           'Arc Memo',
  multicall:      'Multicall3From',
  cctp:           'CCTP v2',
  gateway:        'Circle Gateway',
  erc8004:        'ERC-8004 Identity',
  erc8183:        'Agentic Commerce',
  wusdc:          'Wrapped USDC',
  'arc-dollar':   'Arc Dollar',
  xylonet:        'XyloNet',
  'curve-usdc-eurc': 'Curve USDC/EURC',
  swaparc:        'Swaparc',
  synthra:        'Synthra',
  unitflow:       'UnitFlow',
  arcflow:        'ArcFlow',
  axpha:          'Axpha',
  onmifun:        'Onmifun',
  // Mainnet-only (apps.mainnet.json)
  uniswap:        'Uniswap',
  across:         'Across',
}

/** Return the display name for an app id, falling back to capitalised id. */
export function appName(id) {
  if (typeof id !== 'string') return String(id)
  return NAMES[id] ?? (id.charAt(0).toUpperCase() + id.slice(1))
}
