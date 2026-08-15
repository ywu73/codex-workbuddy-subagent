export const WORKBUDDY_MODELS = [
  "hy3",
  "glm-5.2",
  "minimax-m3",
  "kimi-k2.7",
] as const;

export type WorkBuddyModel = (typeof WORKBUDDY_MODELS)[number];

export const DEFAULT_WORKBUDDY_MODEL: WorkBuddyModel = "hy3";

export const MULTIMODAL_WORKBUDDY_MODELS = new Set<WorkBuddyModel>([
  "minimax-m3",
  "kimi-k2.7",
]);

export function isWorkBuddyModel(value: unknown): value is WorkBuddyModel {
  return typeof value === "string" && (WORKBUDDY_MODELS as readonly string[]).includes(value);
}

export function resolveWorkBuddyModel(
  value: unknown,
  fallback: WorkBuddyModel = DEFAULT_WORKBUDDY_MODEL,
): WorkBuddyModel {
  if (value === undefined || value === null || value === "") return fallback;
  if (!isWorkBuddyModel(value)) {
    throw new Error(
      `Unsupported WorkBuddy model: ${typeof value === "string" ? value : String(value)}. ` +
      `Choose one of: ${WORKBUDDY_MODELS.join(", ")}.`,
    );
  }
  return value;
}

export function workBuddyModelList(): Array<Record<string, string>> {
  return WORKBUDDY_MODELS.map((id) => ({ id, object: "model", owned_by: "workbuddy" }));
}
