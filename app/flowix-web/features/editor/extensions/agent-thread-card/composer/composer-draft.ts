export function getPersistableInputDraft(
  value: string,
  maxChars: number,
): {
  nextDraft: string;
  oversizedDomValue: string | null;
} {
  const oversizedDomValue = value.length > maxChars ? value : null;
  const nextDraft = value.length > 0 && value.length <= maxChars ? value : "";
  return { nextDraft, oversizedDomValue };
}
