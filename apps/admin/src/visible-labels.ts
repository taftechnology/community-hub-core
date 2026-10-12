export function visibleLabels(
  labels: readonly string[],
  entitledKeys: readonly string[],
  map: Readonly<Record<string, string>>,
): string[] {
  return labels.filter((label) => {
    if (label === "Dashboard" || label === "Settings") {
      return true;
    }
    const key = map[label];
    return key !== undefined && entitledKeys.includes(key);
  });
}
