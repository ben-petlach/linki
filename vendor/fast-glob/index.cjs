// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { globSync: tinyGlobSync } = require('tinyglobby')

// @next/eslint-plugin-next calls only globSync(pattern, { onlyDirectories: true }).
// Reject new call shapes so a plugin update cannot silently change lint behavior.
function globSync(pattern, options) {
  if (typeof pattern !== 'string' || options?.onlyDirectories !== true ||
      Object.keys(options).some((key) => key !== 'onlyDirectories')) {
    throw new TypeError('Unsupported fast-glob call from @next/eslint-plugin-next')
  }

  const matches = tinyGlobSync(pattern, {
    absolute: path.isAbsolute(pattern),
    expandDirectories: false,
    onlyDirectories: true,
  })
  const normalizedPattern = pattern.replace(/\/+$/, '')
  const globstarRoot = normalizedPattern.endsWith('/**')
    ? normalizedPattern.slice(0, -3)
    : null

  return matches
    .map((match) => {
      const withoutTrailingSlash = match.replace(/\/+$/, '') || '/'
      return pattern.startsWith('./') ? `./${withoutTrailingSlash}` : withoutTrailingSlash
    })
    .filter((match) => match !== globstarRoot)
}

module.exports = { globSync }
