/**
 * Organisations are unique; person names are not. After onboard, match both.
 */
export function personaAfterOnboarding<T extends { name: string; entityName: string }>(
  personas: readonly T[],
  userName: string,
  entityName: string,
): T | undefined {
  const person = userName.trim();
  const company = entityName.trim();
  return personas.find((p) => p.name === person && p.entityName === company);
}
