# Short invitation resolver

The six-character code is a lookup identifier, not membership authority. The API creates it only after a signed-wallet session proves the circle creator and a live Polygon read confirms the wallet-bound invitation commitment. Resolution also requires a signed session for the intended invitee. The vault contract remains the final authority and verifies the circle address, invitee, high-entropy secret, expiry, nonce, chain ID, one-time use, revocation, capacity and lifecycle.

The resolver stores the encoded invitation payload. That payload contains no financial private key and cannot move funds. Because the contract binds it to one invitee wallet, disclosure alone cannot admit a different wallet. Failed lookups are rate-limited and return the same generic response so callers cannot distinguish unknown, expired, revoked, consumed or wrong-wallet codes.

PostgreSQL availability is required to resolve a short code. Loss or downtime can prevent a pending invitee from looking up the payload, but it cannot alter deposits, balances, ownership, existing membership or withdrawal rights. A creator can revoke the on-chain commitment and issue a replacement invitation. PostgreSQL is not a custody or membership authority.

Verified usernames are a signed-wallet profile index. They resolve only to the wallet that registered the name through a current signed session. The resolved Polygon address is shown for confirmation and remains the identity passed to the contract.

Amoy protocol 1.3 deployments use an immutable 600-second minimum maturity. Production preparation rejects development profiles, non-Polygon-mainnet chain IDs and any minimum below 86,400 seconds. Existing vault timestamps and previously deployed factories are not changed.
