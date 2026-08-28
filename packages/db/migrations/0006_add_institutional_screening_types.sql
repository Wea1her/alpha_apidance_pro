alter table screening_decisions drop constraint if exists screening_decisions_account_type_check;
alter table screening_decisions
  add constraint screening_decisions_account_type_check
  check (account_type in ('PROJECT', 'ALPHA', 'UNKNOWN', 'KOL', 'PERSONAL', 'DEV', 'MEDIA', 'NFT', 'TRADFI', 'CORPORATE', 'CAPITAL', 'CHAIN', 'EXCHANGE', 'FOUNDATION', 'AFFILIATE'));
