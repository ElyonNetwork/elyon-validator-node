-- Elyon Explorer schema. PostgreSQL 15+.
-- All numeric chain values stored as NUMERIC(78,0) — wide enough for uint256.
-- Hex columns are stored lowercased and *without* the 0x prefix to keep
-- equality joins/index lookups fast.

CREATE TABLE IF NOT EXISTS blocks (
  number              BIGINT PRIMARY KEY,
  hash                CHAR(64) NOT NULL UNIQUE,
  parent_hash         CHAR(64) NOT NULL,
  timestamp           BIGINT NOT NULL,
  miner               CHAR(40) NOT NULL,
  gas_used            NUMERIC(78,0) NOT NULL,
  gas_limit           NUMERIC(78,0) NOT NULL,
  base_fee_per_gas    NUMERIC(78,0),
  tx_count            INTEGER NOT NULL DEFAULT 0,
  size                INTEGER NOT NULL DEFAULT 0,
  extra_data          TEXT,
  -- URELAY1 attestation block — raw hex of the relayer list parsed from extraData.
  urelay_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS blocks_ts_idx  ON blocks (timestamp DESC);
CREATE INDEX IF NOT EXISTS blocks_miner_idx ON blocks (miner);

CREATE TABLE IF NOT EXISTS txs (
  hash                CHAR(64) PRIMARY KEY,
  block_number        BIGINT NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_index            INTEGER NOT NULL,
  timestamp           BIGINT NOT NULL,
  from_addr           CHAR(40) NOT NULL,
  to_addr             CHAR(40),
  value               NUMERIC(78,0) NOT NULL,
  gas_used            NUMERIC(78,0) NOT NULL,
  gas_price           NUMERIC(78,0) NOT NULL,
  effective_gas_price NUMERIC(78,0),
  gas_fee             NUMERIC(78,0) NOT NULL,
  status              SMALLINT NOT NULL,            -- 0 fail / 1 success
  nonce               BIGINT NOT NULL,
  input_size          INTEGER NOT NULL,
  method_id           CHAR(8),
  is_contract_creation BOOLEAN NOT NULL DEFAULT FALSE,
  contract_created    CHAR(40),
  -- Elyon-specific fee distribution (computed by the indexer using
  -- per-block registry bps + URELAY1 attestation match). 0 if not attested
  -- / not registered. Sum of these four equals gas_fee.
  fee_node_share      NUMERIC(78,0) NOT NULL DEFAULT 0,
  fee_contract_share  NUMERIC(78,0) NOT NULL DEFAULT 0,
  fee_token_share     NUMERIC(78,0) NOT NULL DEFAULT 0,
  fee_admin_residual  NUMERIC(78,0) NOT NULL DEFAULT 0,
  relayer             CHAR(40)
);
CREATE INDEX IF NOT EXISTS txs_block_idx        ON txs (block_number DESC);
CREATE INDEX IF NOT EXISTS txs_from_idx         ON txs (from_addr, timestamp DESC);
CREATE INDEX IF NOT EXISTS txs_to_idx           ON txs (to_addr, timestamp DESC);
CREATE INDEX IF NOT EXISTS txs_timestamp_idx    ON txs (timestamp DESC);
CREATE INDEX IF NOT EXISTS txs_relayer_idx      ON txs (relayer, timestamp DESC);
CREATE INDEX IF NOT EXISTS txs_method_idx       ON txs (method_id);
-- Address overview fee totals: only rows with a contract/token share matter.
CREATE INDEX IF NOT EXISTS txs_to_fee_share_idx ON txs (to_addr)
  WHERE fee_contract_share <> 0 OR fee_token_share <> 0;

-- Lazy-cached revert reason for failed txs. Populated on first read of a
-- failed tx's detail page. NULL means "not yet attempted".
ALTER TABLE txs ADD COLUMN IF NOT EXISTS revert_kind     VARCHAR(16);
ALTER TABLE txs ADD COLUMN IF NOT EXISTS revert_message  TEXT;
ALTER TABLE txs ADD COLUMN IF NOT EXISTS revert_selector CHAR(10);
ALTER TABLE txs ADD COLUMN IF NOT EXISTS revert_data     TEXT;
ALTER TABLE txs ADD COLUMN IF NOT EXISTS revert_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS internal_txs (
  id                  BIGSERIAL PRIMARY KEY,
  tx_hash             CHAR(64) NOT NULL REFERENCES txs(hash) ON DELETE CASCADE,
  block_number        BIGINT NOT NULL,
  timestamp           BIGINT NOT NULL,
  from_addr           CHAR(40) NOT NULL,
  to_addr             CHAR(40),
  value               NUMERIC(78,0) NOT NULL,
  gas                 NUMERIC(78,0),
  call_type           VARCHAR(16) NOT NULL,
  trace_address       TEXT
);
CREATE INDEX IF NOT EXISTS itx_tx_idx   ON internal_txs (tx_hash);
CREATE INDEX IF NOT EXISTS itx_from_idx ON internal_txs (from_addr, timestamp DESC);
CREATE INDEX IF NOT EXISTS itx_to_idx   ON internal_txs (to_addr, timestamp DESC);

CREATE TABLE IF NOT EXISTS accounts (
  addr                CHAR(40) PRIMARY KEY,
  is_contract         BOOLEAN NOT NULL DEFAULT FALSE,
  bytecode_hash       CHAR(64),
  first_seen_block    BIGINT,
  last_seen_block     BIGINT,
  tx_count            INTEGER NOT NULL DEFAULT 0,
  -- registry-linked roles (resolved by the indexer from UNPRegistry)
  is_operator         BOOLEAN NOT NULL DEFAULT FALSE,
  is_registered_token BOOLEAN NOT NULL DEFAULT FALSE,
  is_registered_contract BOOLEAN NOT NULL DEFAULT FALSE,
  display_name        VARCHAR(96),
  ens_name            VARCHAR(96)
);
CREATE INDEX IF NOT EXISTS accounts_contract_idx ON accounts (is_contract);

CREATE TABLE IF NOT EXISTS tokens (
  addr                CHAR(40) PRIMARY KEY REFERENCES accounts(addr) ON DELETE CASCADE,
  name                VARCHAR(96),
  symbol              VARCHAR(32),
  decimals            INTEGER NOT NULL DEFAULT 18,
  total_supply        NUMERIC(78,0),
  type                VARCHAR(16) NOT NULL DEFAULT 'ERC-20',
  holders             INTEGER NOT NULL DEFAULT 0,
  transfers           INTEGER NOT NULL DEFAULT 0,
  registered          BOOLEAN NOT NULL DEFAULT FALSE,
  registry_stake      NUMERIC(78,0),
  registry_status     VARCHAR(16)
);
CREATE INDEX IF NOT EXISTS tokens_symbol_idx ON tokens (LOWER(symbol));
CREATE INDEX IF NOT EXISTS tokens_name_idx ON tokens (LOWER(name));

CREATE TABLE IF NOT EXISTS token_transfers (
  id                  BIGSERIAL PRIMARY KEY,
  tx_hash             CHAR(64) NOT NULL REFERENCES txs(hash) ON DELETE CASCADE,
  block_number        BIGINT NOT NULL,
  log_index           INTEGER NOT NULL,
  timestamp           BIGINT NOT NULL,
  token_addr          CHAR(40) NOT NULL,
  from_addr           CHAR(40) NOT NULL,
  to_addr             CHAR(40) NOT NULL,
  amount              NUMERIC(78,0) NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS tt_token_idx    ON token_transfers (token_addr, timestamp DESC);
CREATE INDEX IF NOT EXISTS tt_from_idx     ON token_transfers (from_addr, timestamp DESC);
CREATE INDEX IF NOT EXISTS tt_to_idx       ON token_transfers (to_addr, timestamp DESC);

CREATE TABLE IF NOT EXISTS token_balances (
  token_addr          CHAR(40) NOT NULL,
  holder_addr         CHAR(40) NOT NULL,
  balance             NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (token_addr, holder_addr)
);
CREATE INDEX IF NOT EXISTS tb_holder_idx ON token_balances (holder_addr);

CREATE TABLE IF NOT EXISTS contract_sources (
  addr                CHAR(40) PRIMARY KEY REFERENCES accounts(addr) ON DELETE CASCADE,
  name                VARCHAR(128) NOT NULL,
  compiler_version    VARCHAR(64) NOT NULL,
  evm_version         VARCHAR(32),
  optimization        BOOLEAN NOT NULL DEFAULT FALSE,
  optimization_runs   INTEGER,
  license             VARCHAR(64),
  source_code         TEXT NOT NULL,
  abi                 JSONB,
  bytecode            TEXT,
  constructor_args    TEXT,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verifier            CHAR(40)
);

CREATE TABLE IF NOT EXISTS urelay_attestations (
  id                  BIGSERIAL PRIMARY KEY,
  block_number        BIGINT NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_hash             CHAR(64) NOT NULL,
  relayer             CHAR(40) NOT NULL,
  signature           CHAR(130) NOT NULL,
  UNIQUE (block_number, tx_hash)
);
-- Relayer history is queried through txs_relayer_idx. The unused duplicate
-- access path on attestations was retired during the 30-day archive rollout.

-- ─── Admin / explorer-only tables ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  last_indexed_block  BIGINT NOT NULL DEFAULT -1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS domain_config (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  domain              VARCHAR(253),
  acme_email          VARCHAR(253),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO domain_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Materialised stats refreshed every minute by the indexer.
CREATE TABLE IF NOT EXISTS chain_stats (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  latest_block        BIGINT NOT NULL DEFAULT 0,
  total_txs           BIGINT NOT NULL DEFAULT 0,
  total_addresses     BIGINT NOT NULL DEFAULT 0,
  total_contracts     BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,
  median_gas_price    NUMERIC(78,0) NOT NULL DEFAULT 0,
  avg_block_time      DOUBLE PRECISION NOT NULL DEFAULT 12.0,
  tps_24h             DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO chain_stats (id) VALUES (1) ON CONFLICT DO NOTHING;
