/** Whether a conditional chain step should be skipped based on the prior executed step's final output. */
export function shouldSkipStep(previousOutput: string, skipIfPreviousIncludes?: string): boolean {
  return Boolean(skipIfPreviousIncludes && previousOutput.includes(skipIfPreviousIncludes));
}
