-- V1 reports used the retired short-form template. Keep the report history
-- table, but remove those snapshots so the desk exposes V2 only.
delete from report_versions where version < 2;
