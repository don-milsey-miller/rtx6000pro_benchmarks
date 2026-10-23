export function scoreAttempt(result) {
  const passed = Number(result?.grade?.passed ?? 0);
  const total = Number(result?.grade?.total ?? 0);
  const completion = total > 0 ? Math.max(0, Math.min(1, passed / total)) : 0;
  return {
    completion,
    passed: total > 0 && passed === total && result?.classification === "passed",
    weightedCompletion: completion * Number(result?.task?.weight ?? 0),
  };
}

export function scoreSuite(results, billedUsd = 0) {
  const cells = results.map((result) => ({ result, score: scoreAttempt(result) }));
  const totalWeight = cells.reduce((sum, cell) => sum + Number(cell.result?.task?.weight ?? 0), 0);
  const weighted = cells.reduce((sum, cell) => sum + cell.score.weightedCompletion, 0);
  const wallHours = cells.reduce((sum, cell) => sum + Number(cell.result?.wallSeconds ?? 0), 0) / 3600;
  return {
    attempts: cells.length,
    fullPasses: cells.filter((cell) => cell.score.passed).length,
    weightedCompletion: totalWeight ? weighted / totalWeight : 0,
    weightedWork: weighted,
    weightedWorkPerAgentHour: wallHours ? weighted / wallHours : null,
    weightedWorkPerDollar: billedUsd > 0 ? weighted / billedUsd : null,
    totalAgentWallHours: wallHours,
  };
}

export function compareCandidate(baseline, candidate) {
  const baseByCell = new Map(baseline.map((result) => [`${result.task.id}:${result.model.id}`, scoreAttempt(result)]));
  const regressions = [];
  for (const result of candidate) {
    const key = `${result.task.id}:${result.model.id}`;
    const prior = baseByCell.get(key);
    const current = scoreAttempt(result);
    if (prior && current.completion < prior.completion) regressions.push({ key, before: prior.completion, after: current.completion });
  }
  return { eligible: regressions.length === 0, regressions };
}

