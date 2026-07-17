# VIGIL

**A zero-knowledge dead man's switch on Midnight.** A vigil is a watch kept
through the night. While the owner keeps theirs, the vault is sealed. If the
vigil ever ends, the estate passes to an heir whose identity was never on
chain until the day they claim it.

Built during the Midnight Hackathon, July 17-19, 2026.

## Quick start

```bash
cd contract
npm install
npm test        # 21 circuit tests, no proof server needed
```

The compiled contract artifacts (`contract/src/managed/vigil/`) are committed
so the test suite runs without the Compact toolchain. To recompile from
source you need the [Compact compiler](https://docs.midnight.network/):

```bash
cd contract
npm run compact   # compile src/vigil.compact -> src/managed/vigil
```

## The problem

Billions in crypto are permanently lost when holders die or lose keys.
Existing fixes leak or trust: Casa ($250/yr) is custodial with KYC,
Sarcophagus reveals its social graph on Arweave, a lawyer is a human single
point of failure. None can prove liveness or heirship without revealing
identity.

## Rational privacy, applied

Every fact in VIGIL is proven while the underlying data stays private.

| Fact proven on-chain                    | What stays private          |
|-----------------------------------------|-----------------------------|
| "The owner is alive" (`keepVigil`)      | Who the owner is            |
| "An heir is designated" (`heirCommit`)  | Who the heir is             |
| "The vault holds >= X" (`proveFunded`)  | The actual balance          |
| "The deadline truly passed" (`claim`)   | protocol-enforced by block time |
| "The rightful heir claimed" (receipt)   | Everything but the receipt hash |

The deadline uses the kernel's block time via `blockTimeGt`: protocol-enforced
time, not an off-chain witness the prover could lie about. Heartbeats are
bound by `blockTimeGte(now)` so the owner cannot post-date a pulse.

## Circuits

| Circuit | Caller | Does |
|---|---|---|
| `arm(heirCommit, window, now, note)` | owner | Seals owner/heir/balance commitments, starts the vigil |
| `keepVigil(now)` | owner | ZK heartbeat: proves key knowledge, reveals nothing |
| `deposit(amount, newSalt)` | owner | Rolls the private balance commitment forward |
| `proveFunded(threshold)` | owner | Selective disclosure: attests balance >= threshold |
| `claim()` | heir | After the window lapses, proves heir-secret knowledge; emits claim receipt |
