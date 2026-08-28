alter table screening_decisions
  add column if not exists chain_category text,
  add column if not exists playbook_category text;

create index if not exists screening_decisions_project_created_idx
  on screening_decisions (project_id, created_at desc);
