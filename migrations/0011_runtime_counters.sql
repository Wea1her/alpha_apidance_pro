-- 运行指标的增量计数（M5 实测发现的瓶颈）。
--
-- 现象：`readHealthSnapshot` 用多个 `count(*)` 子查询统计全表；20 万事件/判定时
-- `/api/health` 的 p50 已达 31 ms（比列表查询还慢）。数据量继续增长会成为运行状态页的瓶颈。
--
-- 处理：用**语句级触发器**维护计数器，`/api/health` 只读一行。
-- 之所以用语句级（FOR EACH STATEMENT）而不是行级：批量插入一次 5000 行时，
-- 行级触发器会执行 5000 次；语句级只在批次结束时更新一次。
-- 注意：PostgreSQL 不允许一条触发器同时为 INSERT 和 DELETE 指定 transition table，
-- 因此每种事件各建一条触发器。
--
-- 维护范围只覆盖“单调增长且清理会缩减”的两张表（inbound_events、decisions）。
-- 项目/任务/投递的数量仍走实时查询——它们基数远小于事件表且状态变化频繁，
-- 用计数器反而容易与真实状态漂移。

BEGIN;

CREATE TABLE IF NOT EXISTS runtime_counters (
  counter_key text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_counters_non_negative CHECK (value >= 0)
);

-- 统一的自增/自减函数：delta 由触发器按语句影响行数传入。
CREATE OR REPLACE FUNCTION bump_runtime_counter(key text, delta bigint)
RETURNS void AS $$
BEGIN
  INSERT INTO runtime_counters (counter_key, value, updated_at)
  VALUES (key, GREATEST(delta, 0), now())
  ON CONFLICT (counter_key) DO UPDATE
    SET value = GREATEST(runtime_counters.value + delta, 0),
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_inbound_events_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('inbound_events', (SELECT count(*) FROM new_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_inbound_events_delete()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('inbound_events', -(SELECT count(*) FROM old_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_decisions_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('decisions', (SELECT count(*) FROM new_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_decisions_delete()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('decisions', -(SELECT count(*) FROM old_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS count_inbound_events_insert ON inbound_events;
CREATE TRIGGER count_inbound_events_insert
  AFTER INSERT ON inbound_events
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_inbound_events_insert();

DROP TRIGGER IF EXISTS count_inbound_events_delete ON inbound_events;
CREATE TRIGGER count_inbound_events_delete
  AFTER DELETE ON inbound_events
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_inbound_events_delete();

DROP TRIGGER IF EXISTS count_decisions_insert ON decisions;
CREATE TRIGGER count_decisions_insert
  AFTER INSERT ON decisions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_decisions_insert();

DROP TRIGGER IF EXISTS count_decisions_delete ON decisions;
CREATE TRIGGER count_decisions_delete
  AFTER DELETE ON decisions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_decisions_delete();

-- 首次建立时用现有数据回填（写入绝对值而不是增量，幂等）。
INSERT INTO runtime_counters (counter_key, value, updated_at)
SELECT 'inbound_events', (SELECT count(*) FROM inbound_events), now()
ON CONFLICT (counter_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO runtime_counters (counter_key, value, updated_at)
SELECT 'decisions', (SELECT count(*) FROM decisions), now()
ON CONFLICT (counter_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
