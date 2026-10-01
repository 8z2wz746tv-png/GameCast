export function extractCandidateType(candidate: string): string | undefined {
  return candidate.match(/\btyp\s+(host|srflx|relay|prflx)\b/i)?.[1]?.toLowerCase();
}
