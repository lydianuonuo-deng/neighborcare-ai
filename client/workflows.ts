import type {
  ClarificationAnswer,
  Draft,
  ReceiptDraft,
  ReceiptSegment,
  Task,
} from "../shared/types";
import { api, pollTask } from "./api";

type AnalysisServices = {
  analyze: (id: string, version: number) => Promise<Task>;
  wait: (task: Task) => Promise<Task>;
  draft: (id: string) => Promise<Draft>;
};
export async function refreshAfterClarification(
  draft: Draft,
  kind: ClarificationAnswer["kind"],
  options: { enabled: boolean; consent: boolean },
  services: AnalysisServices = {
    analyze: api.analyze,
    wait: pollTask,
    draft: api.draft,
  },
): Promise<Draft> {
  if (
    (kind !== "text" && kind !== "photo") ||
    !options.enabled ||
    !options.consent
  )
    return draft;
  const task = await services.analyze(draft.id, draft.version);
  await services.wait(task);
  return services.draft(draft.id);
}
export function receiptTextSegments(
  draft: Pick<ReceiptDraft, "description"> & { segments?: ReceiptSegment[] },
): ReceiptSegment[] {
  return (
    draft.segments ||
    (
      draft.description.match(/[^。！？!?\n]+[。！？!?]?/gu) || [
        draft.description,
      ]
    )
      .map((text, index) => ({ id: `s${index + 1}`, text: text.trim() }))
      .filter((segment) => !!segment.text)
  );
}
