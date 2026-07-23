export interface ChainProgress {
  totalSteps: number;
  completedSteps: number;
  runningSteps: number;
}

/** Format sequential-chain progress using the active step, not only completed work. */
export function formatChainStatus({ totalSteps, completedSteps, runningSteps }: ChainProgress): string {
  const displayedSteps = runningSteps > 0
    ? Math.min(totalSteps, completedSteps + 1)
    : completedSteps;
  const progress = `${displayedSteps}/${totalSteps} steps`;
  return runningSteps > 0 ? `${progress}, ${runningSteps} running` : progress;
}
