export function soundex(str: string): string {
  if (!str) return '';
  const s = str.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const map: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };
  let code = s[0];
  let prev = map[s[0]] ?? '0';
  for (let i = 1; i < s.length; i++) {
    const curr = map[s[i]] ?? '0';
    if (curr !== '0' && curr !== prev) code += curr;
    prev = curr;
    if (code.length === 4) break;
  }
  return (code + '000').slice(0, 4);
}

export function phoneticMatch(
  query: string,
  candidates: string[],
): { value: string; score: number }[] {
  const qCode = soundex(query);
  return candidates
    .map((c) => ({ value: c, score: soundex(c) === qCode ? 1 : 0 }))
    .filter((r) => r.score > 0);
}
