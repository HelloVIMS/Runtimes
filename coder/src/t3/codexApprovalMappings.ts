// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
type CodexFileChangeKinds = Readonly<
  Record<string, ({type:'add'|'delete'}|{type:'update';move_path?:string|null})>
>;

export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
  readonly fileChanges?: CodexFileChangeKinds;
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map(([path, change]) => {
      const movePath = change.type === "update" ? change.move_path : undefined;
      return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

export function toCodexUserInputAnswers(
  answers: Readonly<Record<string,unknown>>,
  allowedQuestionIds: ReadonlySet<string>,
): Record<string,{answers:string[]}> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) =>
      allowedQuestionIds.has(questionId)
        ? [[questionId, { answers: [...answerValueToStrings(value)] }]]
        : [],
    ),
  );
}
