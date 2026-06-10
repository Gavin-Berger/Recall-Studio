// What the user has selected in the schema timeline. The detail panel resolves
// this against the project tree / change stream / moment list.
export type Selection =
  | { kind: "track"; id: string }
  | { kind: "device"; id: string }
  | { kind: "parameter"; id: string }
  | { kind: "change"; id: string }
  | { kind: "moment"; id: string };
