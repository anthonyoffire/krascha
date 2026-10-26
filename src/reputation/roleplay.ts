const REQUEST =
  /\b(?:(?:act|respond|speak)\s+(?:as|like)|pretend\s+(?:to\s+be|you(?:['’]re| are))|role[\s-]?play\s+(?:as|being)|play\s+(?:the\s+role\s+of|as)|become|you(?:['’]re| are)(?:\s+now)?|imagine\s+you(?:['’]re| are)|(?:take\s+on|adopt|assume)\s+(?:the\s+)?(?:persona|role|identity)\s+of)\s+(.+?)(?=$|[.!?;\n])/giu;
const NEGATED = /\b(?:don't|do not|never|stop|avoid)\b(?:\s+\w+){0,4}\s*$/iu;
const FUNCTIONAL_ROLE =
  /^(?:(?:a|an|the|my|your|our)\s+)?(?:(?:senior|junior|professional|expert|experienced|skilled|friendly|helpful|certified|licensed)\s+)*(?:accountant|actor|analyst|architect|assistant|chef|coach|consultant|customer\s+support\s+(?:agent|representative)|data\s+analyst|designer|detective|doctor|editor|engineer|expert|historian|interviewer|journalist|lawyer|mentor|nurse|programmer|professor|project\s+manager|recruiter|researcher|research\s+assistant|scientist|security\s+analyst|software\s+engineer|teacher|therapist|translator|tutor|writer)\b/iu;

/** True when the prompt asks the AI to embody a distinct persona, not do a job. */
export function detectRoleplay(text: string): boolean {
  for (const match of text.matchAll(REQUEST)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 32), start);
    const persona = match[1]?.trim() ?? '';
    if (persona !== '' && !NEGATED.test(before) && !FUNCTIONAL_ROLE.test(persona)) {
      return true;
    }
  }
  return false;
}
