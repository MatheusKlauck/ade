// The Gestor: deterministic FSM orchestration layer (PLANO-GESTOR-v1 §2).
// The LLM only enters at typed edges via `GestorProvider`; the FSM, scheduler
// and git/push paths are plain deterministic core. This slice (S2/#42) lands
// the provider boundary; fsm/jobs/runtime/worker arrive in #43–#49.

pub mod autonomy;
pub mod dispatch;
pub mod fsm;
pub mod gates;
pub mod jobs;
pub mod notes;
pub mod ollama;
pub mod plan;
pub mod provider;
pub mod publish;
pub mod review;
pub mod runtime;
pub mod stall;
pub mod worker;
