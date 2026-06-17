// Barrel for the Rust→TS type bindings.
//
// GENERATED CONTRACT: every *.ts in this directory is emitted by ts-rs from the
// Rust structs (the source of truth). Do not edit the generated files by hand.
// To regenerate after changing a Rust type: `cd src-tauri && cargo test export_bindings`.
// i64/u64 map to `number` (not bigint) via src-tauri/.cargo/config.toml — the
// Tauri IPC bridge serializes them as JSON numbers.

export type { Workspace } from "./Workspace";
export type { BoardColumn } from "./BoardColumn";
export type { Card } from "./Card";
export type { BoardGetResult } from "./BoardGetResult";
export type { CardDetail } from "./CardDetail";
export type { Label } from "./Label";
export type { IssueComment } from "./IssueComment";
export type { AgentTask } from "./AgentTask";
export type { AgentEvent } from "./AgentEvent";
export type { IssueProposal } from "./IssueProposal";
