create table if not exists email_verifications (
  id serial primary key,
  user_id text not null,
  code_hash text not null,
  salt text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_verifications_user_idx on email_verifications (user_id, created_at desc);
