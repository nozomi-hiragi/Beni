/** Interpret persisted executor results without treating malformed flags as confirmed. */
export function outcomeState(result: unknown): 'known' | 'unknown' | 'invalid' {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'invalid';
  if (!Object.hasOwn(result, 'outcomeUnknown')) return 'known';
  const flag = (result as { outcomeUnknown?: unknown }).outcomeUnknown;
  return flag === false ? 'known' : flag === true ? 'unknown' : 'invalid';
}
