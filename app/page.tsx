export default function Home() {
  return (
    <main className="shell">
      <header className="masthead">
        <div className="candle">
          <div className="flame" />
          <div className="wax" />
        </div>
        <h1>VIGIL</h1>
        <p className="tagline">
          A zero-knowledge dead man&apos;s switch on Midnight.
          <br />
          While the owner keeps their vigil, the vault is sealed.
        </p>
      </header>

      <section className="views">
        <div className="panel">
          <span className="badge owner">Owner console</span>
          <p>
            Arm the vault, keep the vigil with a ZK heartbeat, roll private
            deposits forward, and attest a funding floor without revealing the
            balance. Coming online Saturday.
          </p>
        </div>
        <div className="panel">
          <span className="badge heir">Heir view</span>
          <p>
            The vault as a stranger sees it: commitments and a pulse counter,
            nothing more. When the vigil lapses, the heir proves their secret
            and claims. Coming online Saturday.
          </p>
        </div>
      </section>

      <section className="ledger">
        <h2>What the chain sees</h2>
        <p className="note">
          The full public state of an armed vault. Every identity and amount
          is a commitment.
        </p>
        <table>
          <tbody>
            <tr>
              <td className="k">state</td>
              <td className="v">ARMED</td>
            </tr>
            <tr>
              <td className="k">ownerCommit</td>
              <td className="v">
                0x8f2a…c41e (hash, reveals nothing about the owner)
              </td>
            </tr>
            <tr>
              <td className="k">heirCommit</td>
              <td className="v">
                0x3d7b…9a02 (hash, the heir is unknown until claim day)
              </td>
            </tr>
            <tr>
              <td className="k">balanceCommit</td>
              <td className="v">0x61c9…07f4 (hash, the amount stays private)</td>
            </tr>
            <tr>
              <td className="k">pulses</td>
              <td className="v">7</td>
            </tr>
            <tr>
              <td className="k">attestedFloor</td>
              <td className="v">50,000 (the only number the owner chose to reveal)</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer className="footer">
        Built during the Midnight Hackathon, July 17-19, 2026. Five Compact
        circuits, compiled and tested: arm, keepVigil, deposit, proveFunded,
        claim. The deadline is protocol-enforced by kernel block time, not an
        off-chain witness.
      </footer>
    </main>
  );
}
