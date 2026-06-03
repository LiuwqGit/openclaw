export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Use `skill_workshop` when the user wants to create, update, revise, list, inspect, apply, reject, or quarantine a reusable skill, Skill Workshop proposal, playbook, workflow, procedure, or durable instruction.",
    "Treat a request as durable when it should be saved, repeated, proposed, installed later, shared as a skill, or used as a standing workflow instead of answered once in chat.",
    "Do not create or change skill proposal files manually with `write`, `edit`, `exec`, shell commands, or direct filesystem operations. The final proposal artifact must go through `skill_workshop`.",
    "Use `action=create` for a new skill, `action=update` for an existing approved/live skill, and `action=revise` for an existing pending proposal; keep `description` under 160 bytes and `proposal_content` within the configured body limit.",
    "Before creating or updating a skill, gather concrete example user requests and the intended trigger contexts. If the examples or triggers are materially unclear, ask a focused question before drafting a generic skill.",
    "Write skills for another agent to use later: include durable, non-obvious workflow knowledge, tool/API details, domain constraints, and reusable assets; omit generic advice the model already knows.",
    "Put trigger rules in the SKILL.md frontmatter `description`; the body is only loaded after the skill triggers, so do not hide `when to use` guidance there.",
    "Match the skill's degrees of freedom to the work: concise prose for judgment-heavy workflows, pseudocode or parameterized patterns for medium-variance tasks, and scripts for fragile, repetitive, or deterministic operations.",
    "Use progressive disclosure. Keep SKILL.md focused on the core workflow, move lengthy examples, schemas, variants, and deep references into `support_files`, and link those files directly from SKILL.md.",
    "When reusable scripts, references, or assets would prevent repeated reconstruction, include them in `support_files` with one-level paths such as `scripts/name.ext`, `references/name.md`, or `assets/name.ext`.",
    "Avoid proposal clutter: do not add README, quick-reference, changelog, install guide, or process notes unless that file is itself required for the skill to run.",
    "Pass `goal` and `evidence` when useful so reviewers can see the user need, example prompts, inspected existing skill, or validation behind the proposal.",
    "For `action=update`, pass a concise `description` when the existing live skill description should be shortened in the proposal listing.",
    "For `action=revise`, pass `proposal_id` when known. If it is not known, pass the proposal or skill name in `name` so `skill_workshop` can resolve the pending proposal or return candidates.",
    "Use `action=list` or `action=inspect` only for pending proposal discovery/inspection. Do not use filesystem search for proposal discovery.",
    "If the user names an existing live skill, read or view that skill when needed for context, but create the update proposal through `skill_workshop`.",
    "Generated skills are pending proposals by default. Do not apply, install, approve, enable, or write into live skills unless the user explicitly asks for that separate action.",
    "Use `action=apply`, `action=reject`, or `action=quarantine` only after the user explicitly asks to approve/use/apply, reject, or quarantine a specific proposal. Pass `proposal_id`; if it is not known, use `action=list` or `action=inspect` first.",
    "Do not apply, reject, or quarantine proposals manually with filesystem operations or shell commands. Proposal lifecycle changes must use `skill_workshop`.",
    "You may gather context first, but the durable proposal write or lifecycle change must use `skill_workshop`.",
    "",
  ];
}
