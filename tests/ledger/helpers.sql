-- Balance readers shared by the ledger suites.
--
-- Read only. ledger.wallet_account() creates the account it cannot find, so
-- asking it "is this wallet funded?" would answer its own question. A missing
-- row has to read as zero rather than as a NULL that makes every comparison
-- silently true, which is what the COALESCE is for.
\set QUIET on

CREATE FUNCTION pg_temp.cash(p_wallet text, p_code ledger.cash_code) RETURNS bigint
LANGUAGE sql AS $$
  SELECT COALESCE((SELECT b.balance
                     FROM ledger.account_balance b
                     JOIN ledger.account a ON a.id = b.account_id
                     JOIN ledger.asset   s ON s.id = b.asset_id
                    WHERE a.wallet_address = p_wallet AND a.purpose = 'wallet_free'
                      AND s.cash_code = p_code), 0)
$$;

CREATE FUNCTION pg_temp.fx(p_code ledger.cash_code) RETURNS bigint
LANGUAGE sql AS $$
  SELECT COALESCE((SELECT b.balance
                     FROM ledger.account_balance b
                     JOIN ledger.account a ON a.id = b.account_id
                     JOIN ledger.asset   s ON s.id = b.asset_id
                    WHERE a.purpose = 'system_fx' AND s.cash_code = p_code), 0)
$$;
