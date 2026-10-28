function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

function parseRank(rank: string): [bigint, bigint] {
  const parts = rank.split("/")
  if (parts.length !== 2) throw new Error(`Invalid rank: ${rank}`)
  const numerator = BigInt(parts[0]!)
  const denominator = BigInt(parts[1]!)
  if (denominator <= 0n) throw new Error(`Invalid denominator in rank: ${rank}`)
  return [numerator, denominator]
}

function reduceRational(num: bigint, den: bigint): string {
  if (den < 0n) {
    num = -num
    den = -den
  }
  if (num === 0n) return "0/1"
  const g = gcdBigInt(num, den)
  return `${num / g}/${den / g}`
}

export function calculateRankBetween(prevRank: string | null, nextRank: string | null): string {
  if (prevRank === null && nextRank === null) {
    return "0/1"
  }
  if (prevRank === null) {
    const [n, d] = parseRank(nextRank!)
    return reduceRational(n - d, d)
  }
  if (nextRank === null) {
    const [n, d] = parseRank(prevRank!)
    return reduceRational(n + d, d)
  }

  const [n1, d1] = parseRank(prevRank)
  const [n2, d2] = parseRank(nextRank)

  // Mediant of n1/d1 and n2/d2 is (n1 + n2) / (d1 + d2)
  const num = n1 + n2
  const den = d1 + d2
  return reduceRational(num, den)
}

export function compareRanks(left: string, right: string): number {
  const [leftNumerator, leftDenominator] = parseRank(left)
  const [rightNumerator, rightDenominator] = parseRank(right)
  const difference = leftNumerator * rightDenominator - rightNumerator * leftDenominator
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

export function isValidRank(rank: string): boolean {
  if (typeof rank !== "string") return false
  const match = rank.match(/^(-?\d+)\/(\d+)$/)
  if (!match) return false
  const numStr = match[1]
  const denStr = match[2]
  try {
    const num = BigInt(numStr)
    const den = BigInt(denStr)
    if (den <= 0n) return false
    // must be reduced: gcd(|num|, den) === 1
    if (num === 0n) {
      return den === 1n
    }
    return gcdBigInt(num, den) === 1n
  } catch {
    return false
  }
}

