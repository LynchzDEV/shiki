function versionParts(version: string): number[] {
  const numeric = version.match(/^[\d.]*/)?.[0] ?? ''
  return numeric.split('.').filter(part => part !== '').map(Number)
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function satisfies(version: string, min?: string): boolean {
  return min === undefined || compareVersions(version, min) >= 0
}
